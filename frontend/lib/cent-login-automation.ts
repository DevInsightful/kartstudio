import "server-only";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";

type Credentials = { username: string; password: string };
type WindowBounds = { x: number; y: number; width: number; height: number };
type DevToolsTarget = { id?: string; type?: string; url?: string; webSocketDebuggerUrl?: string };
type CdpResponse = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: {
    result?: { value?: unknown };
    targetId?: string;
    windowId?: number;
    nodeId?: number;
    nodeIds?: number[];
    root?: { nodeId?: number };
    exceptionDetails?: unknown;
  };
  error?: { message?: string };
};
type CdpCommand = (method: string, params: Record<string, unknown>) => Promise<CdpResponse>;
type PageDetails = { name: string; category: string; bio: string };
type PageImages = {
  profileImage: Uint8Array;
  profileImageType: string;
  coverImage: Uint8Array;
  coverImageType: string;
};

const DEBUG_PORT_FILE = "DevToolsActivePort";
const TARGET_WAIT_MS = 30_000;
const FORM_WAIT_MS = 30_000;
const LOGIN_RESULT_WAIT_MS = 30_000;
const PAGE_CREATE_RESPONSE_WAIT_MS = 5 * 60_000;
const PAGE_IMAGE_UPLOAD_WAIT_MS = 120_000;
const PAGE_ACTION_STABLE_MS = 1_500;
const COMMAND_WAIT_MS = 10_000;
const execFileAsync = promisify(execFile);

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeTemporaryPageImages(directory: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (!(["EBUSY", "EPERM", "ENOTEMPTY"] as unknown[]).includes(code) || attempt === 19) throw error;
      await delay(250);
    }
  }
}

function isTransientExecutionContextError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return /cannot find default execution context|execution context was destroyed|context with specified id not found|inspected target navigated or closed/i.test(message);
}

async function restoreCentWindow(profilePath: string, bounds: WindowBounds) {
  const script = `
$ErrorActionPreference = 'Stop'
$profile = [Environment]::GetEnvironmentVariable('KARTSTUDIO_PROFILE_PATH')
$deadline = [DateTime]::UtcNow.AddSeconds(10)
$browserProcess = $null
do {
  $browserProcess = Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and $_.CommandLine.Contains($profile) -and $_.CommandLine -notmatch '(?:^|\\s)--type='
  } | Select-Object -First 1
  if (-not $browserProcess) { Start-Sleep -Milliseconds 250 }
} while (-not $browserProcess -and [DateTime]::UtcNow -lt $deadline)
if (-not $browserProcess) { throw 'Could not find the Cent process for this account profile.' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class KartStudioWindowRestore {
  private delegate bool EnumWindowsCallback(IntPtr hwnd, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
  [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll", SetLastError = true)] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);

  public static bool RestoreTopmost(int processId, int x, int y, int width, int height) {
    IntPtr match = IntPtr.Zero;
    EnumWindows((hwnd, parameter) => {
      uint ownerProcessId;
      GetWindowThreadProcessId(hwnd, out ownerProcessId);
      if (ownerProcessId == processId && IsWindowVisible(hwnd) && GetWindow(hwnd, 4) == IntPtr.Zero) {
        match = hwnd;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    if (match == IntPtr.Zero) return false;
    ShowWindow(match, 9);
    if (!SetWindowPos(match, new IntPtr(-1), x, y, width, height, 0x10 | 0x20 | 0x40 | 0x200)) return false;
    return !IsIconic(match);
  }
}
'@
$restored = [KartStudioWindowRestore]::RestoreTopmost(
  [int]$browserProcess.ProcessId,
  [int]$env:KARTSTUDIO_WINDOW_X,
  [int]$env:KARTSTUDIO_WINDOW_Y,
  [int]$env:KARTSTUDIO_WINDOW_WIDTH,
  [int]$env:KARTSTUDIO_WINDOW_HEIGHT
)
if (-not $restored) { throw 'Cent did not expose a restorable window for this account profile.' }
`;
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    timeout: 15_000,
    encoding: "utf8",
    env: {
      ...process.env,
      KARTSTUDIO_PROFILE_PATH: profilePath,
      KARTSTUDIO_WINDOW_X: String(bounds.x),
      KARTSTUDIO_WINDOW_Y: String(bounds.y),
      KARTSTUDIO_WINDOW_WIDTH: String(bounds.width),
      KARTSTUDIO_WINDOW_HEIGHT: String(bounds.height),
    },
  });
}

async function getFacebookTargets(profilePath: string): Promise<DevToolsTarget[]> {
  let portFile: string;
  try {
    portFile = await readFile(path.join(profilePath, DEBUG_PORT_FILE), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }

  const port = Number(portFile.split(/\r?\n/)[0]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return [];
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) });
  } catch (error) {
    if (error instanceof TypeError || error instanceof DOMException) return [];
    throw error;
  }
  if (!response.ok) return [];

  const targets = await response.json() as DevToolsTarget[];
  return targets.filter((target) => {
    if (target.type !== "page" || !target.url || !target.webSocketDebuggerUrl) return false;
    try {
      const pageHost = new URL(target.url).hostname.toLowerCase();
      const debuggerUrl = new URL(target.webSocketDebuggerUrl);
      const loopbackHost = ["127.0.0.1", "localhost", "[::1]"].includes(debuggerUrl.hostname);
      return (pageHost === "facebook.com" || pageHost.endsWith(".facebook.com")) &&
        debuggerUrl.protocol === "ws:" && loopbackHost && Number(debuggerUrl.port) === port;
    } catch {
      return false;
    }
  });
}

async function getFacebookTarget(profilePath: string): Promise<DevToolsTarget | null> {
  return (await getFacebookTargets(profilePath))[0] ?? null;
}

export type FacebookManagedPage = { name: string; followerCount: number | null };

export async function readFacebookManagedPages(profilePath: string): Promise<FacebookManagedPage[]> {
  const activePort = await readFile(path.join(profilePath, DEBUG_PORT_FILE), "utf8");
  const [portLine, browserPath] = activePort.split(/\r?\n/);
  const port = Number(portLine);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || !browserPath?.startsWith("/devtools/browser/")) {
    throw new Error("Cent's browser connection is not ready. Reopen this account profile and retry.");
  }

  const browser = await connect(`ws://127.0.0.1:${port}${browserPath}`);
  let pageSocket: WebSocket | null = null;
  let targetId: string | null = null;
  try {
    const created = await sendCommand(browser, 1, "Target.createTarget", {
      url: "https://www.facebook.com/pages/?category=your_pages",
      newWindow: false,
    });
    targetId = typeof created.result?.targetId === "string" ? created.result.targetId : null;
    if (!targetId) throw new Error("Cent could not open a temporary Facebook Pages tab.");

    const deadline = Date.now() + 30_000;
    let target: DevToolsTarget | undefined;
    while (Date.now() < deadline) {
      target = (await getFacebookTargets(profilePath)).find((item) => item.id === targetId);
      if (target?.webSocketDebuggerUrl) break;
      await delay(250);
    }
    if (!target?.webSocketDebuggerUrl) throw new Error("Facebook's Pages list did not open in this account profile.");

    pageSocket = await connect(target.webSocketDebuggerUrl);
    let commandId = 0;
    const command: CdpCommand = (method, params) => sendCommand(pageSocket!, ++commandId, method, params);
    await command("Page.enable", {});

    const inspectDeadline = Date.now() + 45_000;
    let pages: FacebookManagedPage[] = [];
    while (Date.now() < inspectDeadline) {
      const result = await evaluatePageScript(command, `(() => {
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' &&
            style.display !== 'none' && element.getClientRects().length > 0;
        };
        const countFrom = (text) => {
          const match = text.match(/([\\d,.]+)\\s*([KMB])?\\s+followers?\\b/i);
          if (!match) return null;
          const value = Number(match[1].replace(/,/g, ''));
          const multiplier = ({ K: 1e3, M: 1e6, B: 1e9 })[(match[2] || '').toUpperCase()] || 1;
          return Number.isFinite(value) ? Math.round(value * multiplier) : null;
        };
        const candidates = new Map();
        const pageContent = document.querySelector('[role="main"]') || document.body;
        const excludedRoutes = new Set(['pages', 'watch', 'groups', 'reels', 'marketplace', 'friends', 'settings', 'notifications', 'messages', 'events']);
        for (const anchor of pageContent.querySelectorAll('a[href]')) {
          if (!visible(anchor)) continue;
          const href = new URL(anchor.href, location.href);
          if (href.hostname !== 'facebook.com' && !href.hostname.endsWith('.facebook.com')) continue;
          const firstPath = href.pathname.split('/').filter(Boolean)[0]?.toLowerCase() || '';
          if (excludedRoutes.has(firstPath) || (href.pathname === '/' && !href.searchParams.has('id'))) continue;
          let container = anchor;
          for (let depth = 0; container && depth < 6; depth++, container = container.parentElement) {
            const text = (container.innerText || '').replace(/\\s+/g, ' ').trim();
            if (!text) continue;
            const lines = (container.innerText || '').split('\\n').map((line) => line.trim()).filter(Boolean);
            const ignored = /^(manage|edit|view|see all|create|more|notifications|switch)$/i;
            const name = lines.find((line) => !ignored.test(line) && !/\\bfollowers?\\b/i.test(line) && line.length <= 100);
            if (!name) continue;
            const key = href.pathname + href.search;
            const followerCount = countFrom(text);
            const previous = candidates.get(key);
            if (!previous || (previous.followerCount === null && followerCount !== null)) {
              candidates.set(key, { name, followerCount });
            }
            break;
          }
        }
        return {
          path: location.pathname,
          body: (document.body?.innerText || '').slice(0, 8000),
          pages: [...candidates.values()],
        };
      })()`);
      if (result && typeof result === "object" && "path" in result && typeof result.path === "string" &&
          "body" in result && typeof result.body === "string" && "pages" in result && Array.isArray(result.pages)) {
        const body = result.body.toLowerCase();
        if (/login|log in to facebook|create an account/.test(body) && !/your pages|managed pages/.test(body)) {
          throw new Error("This Facebook account needs sign-in before its Pages can be listed.");
        }
        pages = result.pages.filter((item): item is FacebookManagedPage => item && typeof item === "object" &&
          "name" in item && typeof item.name === "string" && "followerCount" in item &&
          (item.followerCount === null || typeof item.followerCount === "number"));
        if (pages.length || /no pages|you don't manage any pages|you do not manage any pages/i.test(body)) return pages;
      }
      await delay(500);
    }
    throw new Error("Facebook opened the Pages list, but KartStudio could not read its Page names and follower counts.");
  } finally {
    pageSocket?.close();
    if (targetId) {
      try { await sendCommand(browser, 2, "Target.closeTarget", { targetId }); } catch { /* Temporary tab may already be closed. */ }
    }
    browser.close();
  }
}

async function waitForNewFacebookTarget(
  profilePath: string,
  knownTargetIds: Set<string>,
  command: CdpCommand,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const hasSetupAction = await evaluatePageScript(command, `(() => [...document.querySelectorAll('[role="button"], button, a')].some((element) => {
        const label = (element.getAttribute('aria-label') || element.innerText || '').trim().toLowerCase();
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return ['next', 'skip', 'done'].includes(label) && rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' &&
          style.display !== 'none' && element.getClientRects().length > 0;
      }))()`);
      if (hasSetupAction === true) return null;
    } catch (error) {
      if (!isTransientExecutionContextError(error)) throw error;
    }
    const targets = await getFacebookTargets(profilePath);
    const createdTarget = targets.find((candidate) => candidate.id && !knownTargetIds.has(candidate.id));
    if (createdTarget) return createdTarget;
    await delay(400);
  }
  return null;
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { perMessageDeflate: false });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("Cent's local automation connection timed out."));
    }, COMMAND_WAIT_MS);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function sendCommand(socket: WebSocket, id: number, method: string, params: Record<string, unknown>) {
  return new Promise<CdpResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Cent's local automation command timed out."));
    }, COMMAND_WAIT_MS);
    function finish(error: Error | null, response?: CdpResponse) {
      clearTimeout(timer);
      socket.off("message", onMessage);
      if (error) reject(error);
      else if (response) resolve(response);
      else reject(new Error("Cent returned an empty automation response."));
    }
    function onMessage(data: WebSocket.RawData) {
      let message: CdpResponse;
      try {
        message = JSON.parse(data.toString()) as CdpResponse;
      } catch {
        finish(new Error("Cent returned an invalid automation response."));
        return;
      }
      if (message.id !== id) return;
      if (message.error) finish(new Error(message.error.message ?? "Cent rejected the automation command."));
      else finish(null, message);
    }

    socket.on("message", onMessage);
    if (socket.readyState !== WebSocket.OPEN) {
      finish(new Error("Cent's automation connection closed before the browser command completed."));
      return;
    }
    try {
      socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) finish(error);
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error("Cent's browser command could not be sent."));
    }
  });
}

type PageNetworkRecord = { requestId: string; resourceType: string; method: string; status?: number; failure?: string };

function observePageNetwork(socket: WebSocket) {
  const records = new Map<string, PageNetworkRecord>();
  const listener = (data: WebSocket.RawData) => {
    let message: CdpResponse;
    try {
      message = JSON.parse(data.toString()) as CdpResponse;
    } catch {
      return;
    }
    const params = message.params;
    if (!params || typeof params.requestId !== "string") return;
    const requestId = params.requestId;
    if (message.method === "Network.requestWillBeSent") {
      const request = params.request;
      if (!request || typeof request !== "object") return;
      const requestData = request as Record<string, unknown>;
      const method = typeof requestData.method === "string" ? requestData.method : "";
      const resourceType = typeof params.type === "string" ? params.type : "";
      if (method.toUpperCase() === "POST" || resourceType === "XHR" || resourceType === "Fetch") {
        records.set(requestId, { requestId, method, resourceType });
      }
    } else if (message.method === "Network.responseReceived") {
      const record = records.get(requestId);
      const response = params.response;
      if (record && response && typeof response === "object" && "status" in response &&
          typeof response.status === "number") record.status = response.status;
    } else if (message.method === "Network.loadingFailed") {
      const record = records.get(requestId);
      if (record) record.failure = typeof params.errorText === "string" ? params.errorText : "request failed";
    }
  };
  socket.on("message", listener);
  return {
    snapshot: () => [...records.values()].map(({ requestId: _requestId, ...record }) => ({ ...record })),
    dispose: () => socket.off("message", listener),
  };
}

async function evaluatePageScript(command: CdpCommand, expression: string) {
  const response = await command("Runtime.evaluate", { expression, returnByValue: true });
  if (response.result?.exceptionDetails) {
    const details = response.result.exceptionDetails;
    const detailText = typeof details === "string" ? details : JSON.stringify(details);
    const transientMessage = detailText.match(/cannot find default execution context|execution context was destroyed|context with specified id not found|inspected target navigated or closed/i)?.[0];
    if (transientMessage) throw new Error(transientMessage);
    throw new Error("Facebook Page browser script failed.");
  }
  return response.result?.result?.value;
}

async function clickWithNativeInput(command: CdpCommand, x: number, y: number) {
  await command("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await command("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await command("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

async function commitPageBioWithKeyboard(command: CdpCommand, bioValue: string) {
  const position = await evaluatePageScript(command, `(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden" &&
        element.offsetParent !== null;
    };
    const fields = [...document.querySelectorAll('input:not([type="hidden"]), textarea, [role="textbox"], [contenteditable="true"]')]
      .filter(visible);
    const fieldText = (element) => [
      element.getAttribute("aria-label"),
      element.getAttribute("placeholder"),
      element.labels ? [...element.labels].map((label) => label.innerText).join(" ") : "",
      element.closest("label")?.innerText,
    ].filter(Boolean).join(" ").trim().toLowerCase();
    const field = fields.find((element) => /^bio(?:\\s*\\(optional\\))?$/.test(fieldText(element))) ??
      [...document.querySelectorAll("label")].find((label) => visible(label) &&
        [...label.querySelectorAll("span")].some((span) => /^bio(?:\\s*\\(optional\\))?$/.test(span.innerText.trim().toLowerCase())))
        ?.control;
    if (!field) return null;
    const rect = field.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!position || typeof position !== "object" || !("x" in position) || typeof position.x !== "number" ||
      !("y" in position) || typeof position.y !== "number") return false;

  await clickWithNativeInput(command, position.x, position.y);
  await command("Input.dispatchKeyEvent", {
    type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65,
  });
  await command("Input.dispatchKeyEvent", {
    type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65,
  });
  await command("Input.insertText", { text: bioValue });
  await command("Input.dispatchKeyEvent", {
    type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
  });
  await command("Input.dispatchKeyEvent", {
    type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
  });
  await delay(500);

  const committedValue = await evaluatePageScript(command, `(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden" &&
        element.offsetParent !== null;
    };
    const fields = [...document.querySelectorAll('input:not([type="hidden"]), textarea, [role="textbox"], [contenteditable="true"]')]
      .filter(visible);
    const fieldText = (element) => [
      element.getAttribute("aria-label"),
      element.getAttribute("placeholder"),
      element.labels ? [...element.labels].map((label) => label.innerText).join(" ") : "",
      element.closest("label")?.innerText,
    ].filter(Boolean).join(" ").trim().toLowerCase();
    const field = fields.find((element) => /^bio(?:\\s*\\(optional\\))?$/.test(fieldText(element))) ??
      [...document.querySelectorAll("label")].find((label) => visible(label) &&
        [...label.querySelectorAll("span")].some((span) => /^bio(?:\\s*\\(optional\\))?$/.test(span.innerText.trim().toLowerCase())))
        ?.control;
    if (!field) return "";
    const value = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
      ? field.value
      : field instanceof HTMLElement && field.isContentEditable ? field.innerText : field.textContent;
    return (value || "").replace(/\\u00a0/g, " ").replace(/\\r\\n?/g, "\\n").replace(/[ \\t]+/g, " ").trim();
  })()`);
  const expectedValue = bioValue.replace(/\u00a0/g, " ").replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim();
  return committedValue === expectedValue;
}

async function clickCreatePageButton(command: CdpCommand, details: PageDetails) {
  const clickExpression = `(() => {
    const expected = ${JSON.stringify(details)};
    const normalize = (value) => (value || "").normalize("NFKD").replace(/[\\u0300-\\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 &&
        getComputedStyle(element).visibility !== "hidden" && element.offsetParent !== null;
    };
    const controls = [...document.querySelectorAll('input:not([type="hidden"]), textarea, [role="textbox"], [role="combobox"], [contenteditable="true"]')]
      .filter(visible);
    const fieldText = (element) => {
      const labelText = element.labels ? [...element.labels]
        .flatMap((label) => [...label.querySelectorAll("span")].map((span) => span.innerText.trim()))
        .find(Boolean) : "";
      return (element.getAttribute("aria-label") || element.getAttribute("placeholder") ||
        labelText || element.closest("label")?.innerText || "").trim().toLowerCase();
    };
    const findField = (pattern, expectedValue) => {
      const direct = controls.find((field) => pattern.test(fieldText(field)));
      if (direct) return direct;
      const label = [...document.querySelectorAll("label")].find((candidate) => visible(candidate) &&
        [...candidate.querySelectorAll("span")].some((span) =>
          pattern.test(span.innerText.trim().toLowerCase())));
      const labelled = label?.control ??
        label?.querySelector('input, textarea, [role="textbox"], [role="combobox"], [contenteditable="true"]');
      if (labelled) return labelled;
      // Facebook sometimes renders the visible field label outside the input's
      // associated <label>; use the exact populated value as a safe fallback.
      const wanted = normalizeValue(expectedValue);
      return controls.find((field) => valueOf(field) === wanted) ?? null;
    };
    const normalizeValue = (value) => (value || "").replace(/\\u00a0/g, " ")
      .replace(/\\r\\n?/g, "\\n").replace(/[ \\t]+/g, " ").trim();
    const valueOf = (field) => normalizeValue(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
      ? field.value
      : field instanceof HTMLElement && field.isContentEditable ? field.innerText : field.innerText || field.textContent || "");
    const name = findField(/^page\\s*name(?:\\s*\\(required\\))?$/, expected.name);
    const bio = findField(/^bio(?:\\s*\\(optional\\))?$/, expected.bio);
    const selected = [...document.querySelectorAll('[aria-label="Selected values"] [role="listitem"]')]
      .map((element) => element.innerText.trim()).filter(Boolean);
    if (!name || valueOf(name) !== normalizeValue(expected.name) || !bio || valueOf(bio) !== normalizeValue(expected.bio)) {
      return {
        state: "fields-unverified",
        nameFound: Boolean(name),
        nameMatches: Boolean(name && valueOf(name) === normalizeValue(expected.name)),
        bioFound: Boolean(bio),
        bioMatches: Boolean(bio && valueOf(bio) === normalizeValue(expected.bio)),
      };
    }
    if (selected.length === 0) return { state: "category-unverified", selectedCategoryCount: 0 };
    const target = [...document.querySelectorAll('[role="button"][aria-label="Create Page"]')]
      .find(visible) ?? [...document.querySelectorAll("span")]
        .find((element) => element.innerText.trim() === "Create Page" && visible(element))
        ?.closest('[role="button"], a, button');
    if (!target) return { state: "button-unavailable" };
    if ((target instanceof HTMLButtonElement && target.disabled) || target.getAttribute("aria-disabled") === "true") {
      return { state: "button-disabled" };
    }
    target.scrollIntoView({ block: "center" });
    const rect = target.getBoundingClientRect();
    return { state: "ready", x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`;
  let first: unknown;
  const readyDeadline = Date.now() + 30_000;
  while (Date.now() < readyDeadline) {
    try {
      first = await evaluatePageScript(command, clickExpression);
    } catch (error) {
      if (!isTransientExecutionContextError(error)) throw error;
      await delay(400);
      continue;
    }
    if (first && typeof first === "object" && "state" in first && first.state === "ready") break;
    await delay(400);
  }
  if (!first || typeof first !== "object" || !("state" in first)) {
    throw new Error("Facebook Create Page click script returned an unexpected result.");
  }
  if (first.state === "fields-unverified") {
    console.warn("[page-create] Create Page pre-click field verification failed.", first);
    return "fields-unverified" as const;
  }
  if (first.state === "category-unverified") return "category-unverified" as const;
  if (first.state === "button-unavailable" || first.state === "button-disabled") {
    return "button-unavailable" as const;
  }
  if (first.state !== "ready" || !("x" in first) || typeof first.x !== "number" ||
      !("y" in first) || typeof first.y !== "number") {
    throw new Error("Could not determine the Create Page button position.");
  }

  await clickWithNativeInput(command, first.x, first.y);
  if (process.env.NODE_ENV !== "production") {
    console.info("[page-create] Clicked the Create Page control with native browser input.");
  }
  await delay(1_000);

  let retryState: unknown;
  try {
    retryState = await evaluatePageScript(command, `(() => {
      const expected = ${JSON.stringify(details)};
      const normalize = (value) => (value || "").normalize("NFKD").replace(/[\\u0300-\\u036f]/g, "")
        .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 &&
          getComputedStyle(element).visibility !== "hidden" && element.offsetParent !== null;
      };
      const fields = [...document.querySelectorAll('input:not([type="hidden"]), textarea, [role="textbox"], [role="combobox"], [contenteditable="true"]')]
        .filter(visible);
      const fieldText = (element) => {
        const labelText = element.labels ? [...element.labels]
          .flatMap((label) => [...label.querySelectorAll("span")].map((span) => span.innerText.trim()))
          .find(Boolean) : "";
        return (element.getAttribute("aria-label") || element.getAttribute("placeholder") ||
          labelText || element.closest("label")?.innerText || "").trim().toLowerCase();
      };
      const findField = (pattern) => {
        const direct = fields.find((field) => pattern.test(fieldText(field)));
        if (direct) return direct;
        const label = [...document.querySelectorAll("label")].find((candidate) => visible(candidate) &&
          [...candidate.querySelectorAll("span")].some((span) =>
            pattern.test(span.innerText.trim().toLowerCase())));
        return label?.control ??
          label?.querySelector('input, textarea, [role="textbox"], [role="combobox"], [contenteditable="true"]');
      };
      const normalizeValue = (value) => (value || "").replace(/\\u00a0/g, " ")
        .replace(/\\r\\n?/g, "\\n").replace(/[ \\t]+/g, " ").trim();
      const valueOf = (field) => normalizeValue(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
        ? field.value
        : field instanceof HTMLElement && field.isContentEditable ? field.innerText : field.innerText || field.textContent || "");
      const name = findField(/^page\\s*name(?:\\s*\\(required\\))?$/);
      const bio = findField(/^bio(?:\\s*\\(optional\\))?$/);
      const selected = [...document.querySelectorAll('[aria-label="Selected values"] [role="listitem"]')]
        .map((element) => element.innerText.trim()).filter(Boolean);
      if (!name || valueOf(name) !== normalizeValue(expected.name) || !bio || valueOf(bio) !== normalizeValue(expected.bio) ||
          selected.length === 0) {
        return { state: "fields-changed", nameFound: Boolean(name), bioFound: Boolean(bio), selectedCategoryCount: selected.length };
      }
      const button = [...document.querySelectorAll('[role="button"][aria-label="Create Page"]')]
        .find(visible);
      if (!button || button.getAttribute("aria-disabled") === "true" ||
          (button instanceof HTMLButtonElement && button.disabled)) return { state: "changed" };
      button.scrollIntoView({ block: "center" });
      const rect = button.getBoundingClientRect();
      return { state: "visible", x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
  } catch (error) {
    if (!isTransientExecutionContextError(error)) throw error;
  }
  if (retryState && typeof retryState === "object" && "state" in retryState &&
      retryState.state === "visible" && "x" in retryState && typeof retryState.x === "number" &&
      "y" in retryState && typeof retryState.y === "number") {
    if (process.env.NODE_ENV !== "production") {
      console.info("[page-create] Facebook is still processing Create Page; waiting for the next setup step instead of submitting again.");
    }
  }
  return "clicked" as const;
}

const PAGE_SETUP_ACTIONS = ["Next", "Skip", "Done"] as const;
type PageSetupAction = typeof PAGE_SETUP_ACTIONS[number];

type PageSetupSnapshot = { body: string; actions: string[]; heading: string; step: number | null };

async function readPageSetupSnapshot(command: CdpCommand): Promise<PageSetupSnapshot | null> {
  const value = await evaluatePageScript(command, `(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" &&
        style.display !== "none" && element.getClientRects().length > 0;
    };
    const allowed = ${JSON.stringify(PAGE_SETUP_ACTIONS.map((label) => label.toLowerCase()))};
    const actions = [...document.querySelectorAll('[role="button"], button, a')].filter(visible)
      .map((element) => (element.getAttribute("aria-label") || element.innerText || "").trim())
      .filter((label) => allowed.includes(label.toLowerCase()));
    const body = (document.body?.innerText || "").replace(/\\s+/g, " ").trim();
    const headings = [...document.querySelectorAll('h1, h2, [role="heading"]')]
      .filter(visible).map((element) => (element.innerText || "").trim()).filter(Boolean);
    const stepMatch = body.match(/\\bstep\\s+(\\d+)\\s+of\\s+\\d+\\b/i);
    return {
      body: body.slice(0, 1600),
      actions: [...new Set(actions)],
      heading: headings.join(" | "),
      step: stepMatch ? Number(stepMatch[1]) : null,
    };
  })()`);
  if (!value || typeof value !== "object" || !("body" in value) || typeof value.body !== "string" ||
      !("actions" in value) || !Array.isArray(value.actions) || !("heading" in value) || typeof value.heading !== "string") return null;
  return {
    body: value.body,
    actions: value.actions.filter((label): label is string => typeof label === "string"),
    heading: value.heading,
    step: "step" in value && typeof value.step === "number" ? value.step : null,
  };
}

async function clickAvailablePageSetupAction(
  command: CdpCommand,
  requiredAction?: PageSetupAction,
  timeoutMs = 180_000,
  stableReadyMs = 0,
) {
  // Facebook can keep Next disabled while it processes the uploaded images.
  // Inspect all currently visible actions and wait for an enabled one.
  const deadline = Date.now() + timeoutMs;
  const priority: PageSetupAction[] = requiredAction
    ? [requiredAction]
    : ["Next", "Skip", "Done"];
  let readySignature = "";
  let readySince = 0;
  while (Date.now() < deadline) {
    let state: unknown;
    try {
      state = await evaluatePageScript(command, `(() => {
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" &&
            style.display !== "none" && element.getClientRects().length > 0;
        };
        const allowed = ${JSON.stringify(PAGE_SETUP_ACTIONS.map((label) => label.toLowerCase()))};
        const candidates = [...document.querySelectorAll('[role="button"], button, a')].filter(visible).map((element) => ({
          element,
          label: (element.getAttribute("aria-label") || element.innerText || "").trim(),
        })).filter((candidate) => allowed.includes(candidate.label.toLowerCase()));
        const enabled = (element) => element.getAttribute("aria-disabled") !== "true" &&
          !element.hasAttribute("disabled") && getComputedStyle(element).pointerEvents !== "none" &&
          !(element instanceof HTMLButtonElement && element.disabled);
        const uploadBusy = [...document.querySelectorAll('[aria-busy="true"], [role="status"], [aria-live]')]
          .filter(visible).some((element) => element.getAttribute("aria-busy") === "true" ||
            /\\b(uploading|processing|saving|preparing)\\b/i.test(element.innerText || ""));
        const body = (document.body?.innerText || "").replace(/\\s+/g, " ").trim();
        const headings = [...document.querySelectorAll('h1, h2, [role="heading"]')]
          .filter(visible).map((element) => (element.innerText || "").trim()).filter(Boolean);
        const heading = headings.join(" | ");
        const stepMatch = body.match(/\\bstep\\s+(\\d+)\\s+of\\s+\\d+\\b/i);
        const step = stepMatch ? Number(stepMatch[1]) : null;
        for (const expected of ${JSON.stringify(priority)}) {
          const candidate = candidates.find((item) => item.label.toLowerCase() === expected.toLowerCase() && enabled(item.element));
          if (!candidate) continue;
          if (uploadBusy) return { state: "processing" };
          candidate.element.scrollIntoView({ block: "center" });
          return { state: "ready", label: candidate.label, heading, step };
        }
        return { state: uploadBusy ? "processing" : candidates.length ? "disabled" : "waiting" };
      })()`);
    } catch (error) {
      if (!isTransientExecutionContextError(error)) throw error;
      readySignature = "";
      readySince = 0;
      await delay(350);
      continue;
    }
    if (state && typeof state === "object" && "state" in state && state.state === "ready" &&
        "label" in state && typeof state.label === "string" && "heading" in state &&
        typeof state.heading === "string" &&
        "step" in state && (state.step === null || typeof state.step === "number")) {
      const signature = `${state.label}|${state.heading}|${state.step ?? "unknown"}`;
      if (signature !== readySignature) {
        readySignature = signature;
        readySince = Date.now();
      }
      if (Date.now() - readySince < stableReadyMs) {
        await delay(500);
        continue;
      }
      const clicked = await evaluatePageScript(command, `(() => {
        const label = ${JSON.stringify(state.label)};
        const expectedStep = ${JSON.stringify(state.step)};
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" &&
            style.display !== "none" && element.getClientRects().length > 0;
        };
        const enabled = (element) => element.getAttribute("aria-disabled") !== "true" &&
          !element.hasAttribute("disabled") && getComputedStyle(element).pointerEvents !== "none" &&
          !(element instanceof HTMLButtonElement && element.disabled);
        const body = (document.body?.innerText || "").replace(/\\s+/g, " ");
        const stepMatch = body.match(/\\bstep\\s+(\\d+)\\s+of\\s+\\d+\\b/i);
        const currentStep = stepMatch ? Number(stepMatch[1]) : null;
        if (expectedStep !== null && currentStep !== expectedStep) return false;
        const uploadBusy = [...document.querySelectorAll('[aria-busy="true"], [role="status"], [aria-live]')]
          .filter(visible).some((element) => element.getAttribute("aria-busy") === "true" ||
            /\\b(uploading|processing|saving|preparing)\\b/i.test(element.innerText || ""));
        if (uploadBusy) return false;
        const button = [...document.querySelectorAll('[role="button"], button, a')].find((element) =>
          visible(element) && enabled(element) &&
          (element.getAttribute("aria-label") || element.innerText || "").trim().toLowerCase() === label.toLowerCase());
        if (!button) return false;
        button.focus({ preventScroll: true });
        button.click();
        return true;
      })()`);
      if (clicked !== true) {
        readySignature = "";
        readySince = 0;
        await delay(350);
        continue;
      }
      if (process.env.NODE_ENV !== "production") {
        console.info(`[page-create] Activated Facebook's ${state.label} control after it remained ready for ${stableReadyMs} ms.`);
      }
      return {
        label: state.label as PageSetupAction,
        beforeHeading: state.heading,
        beforeStep: state.step as number | null,
      };
    }
    readySignature = "";
    readySince = 0;
    await delay(350);
  }
  return null;
}

async function waitForPageSetupProgress(
  command: CdpCommand,
  clickedLabel: string,
  beforeHeading: string,
  beforeStep: number | null = null,
  timeoutMs = 180_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const snapshot = await readPageSetupSnapshot(command);
      if (snapshot && ((beforeStep !== null && snapshot.step !== null && snapshot.step !== beforeStep) ||
          (beforeHeading && snapshot.heading && snapshot.heading !== beforeHeading) ||
          (!snapshot.actions.some((label) => label.toLowerCase() === clickedLabel.toLowerCase()) && snapshot.actions.length > 0))) return true;
    } catch (error) {
      if (!isTransientExecutionContextError(error)) throw error;
    }
    await delay(350);
  }
  return false;
}

async function waitForFacebookPageCreationCompletion(
  command: CdpCommand,
  pageName: string,
  timeoutMs = 180_000,
) {
  const deadline = Date.now() + timeoutMs;
  const normalize = (value: string) => value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const expectedName = normalize(pageName);
  let confirmedSince = 0;
  while (Date.now() < deadline) {
    try {
      const state = await evaluatePageScript(command, `(() => {
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" &&
            style.display !== "none" && element.getClientRects().length > 0;
        };
        const body = (document.body?.innerText || "").replace(/\\s+/g, " ").trim();
        const actions = [...document.querySelectorAll('[role="button"], button, a')].filter(visible)
          .map((element) => (element.getAttribute("aria-label") || element.innerText || "").trim().toLowerCase());
        const stepMatch = body.match(/\\bstep\\s+(\\d+)\\s+of\\s+\\d+\\b/i);
        return { path: location.pathname, title: document.title, body: body.slice(0, 5000),
          step: stepMatch ? Number(stepMatch[1]) : null, actions };
      })()`);
      if (state && typeof state === "object" && "path" in state && typeof state.path === "string" &&
          "title" in state && typeof state.title === "string" && "body" in state && typeof state.body === "string" &&
          "step" in state && (state.step === null || typeof state.step === "number") &&
          "actions" in state && Array.isArray(state.actions)) {
        const text = normalize(`${state.title} ${state.body}`);
        const hasPageName = expectedName.length > 0 && text.includes(expectedName);
        const hasSuccessMessage = /\b(page created|your page is ready|successfully created|page was created)\b/i.test(state.body);
        const setupActions = state.actions.some((action) => typeof action === "string" &&
          ["next", "skip", "done"].includes(action));
        const isCreationRoute = /\/pages\/creation(?:\/|$)/i.test(state.path);
        const confirmed = hasSuccessMessage || (!isCreationRoute && hasPageName && state.step === null && !setupActions);
        if (confirmed) {
          if (!confirmedSince) confirmedSince = Date.now();
          if (Date.now() - confirmedSince >= 3_000) return true;
        } else {
          confirmedSince = 0;
        }
      }
    } catch (error) {
      if (!isTransientExecutionContextError(error)) throw error;
      confirmedSince = 0;
    }
    await delay(500);
  }
  return false;
}

async function hasFacebookPageImageUploadControls(command: CdpCommand) {
  const value = await evaluatePageScript(command, `(() => {
    const kinds = new Set();
    for (const input of document.querySelectorAll('input[type="file"][accept*="image"]')) {
      let container = input.parentElement;
      for (let depth = 0; container && depth < 12; depth++, container = container.parentElement) {
        const text = (container.innerText || "").toLowerCase();
        if (text.includes("add profile picture")) kinds.add("profile");
        if (text.includes("add cover photo")) kinds.add("cover");
      }
    }
    return kinds.has("profile") && kinds.has("cover");
  })()`);
  return value === true;
}

async function waitForFacebookPageImageUploads(
  command: CdpCommand,
  uploadStartedAt: number,
  timeoutMs = PAGE_IMAGE_UPLOAD_WAIT_MS,
) {
  const deadline = Date.now() + timeoutMs;
  let lastCompletedCount = -1;
  while (Date.now() < deadline) {
    const value = await evaluatePageScript(command, `(() => {
      const startedAt = ${JSON.stringify(uploadStartedAt)};
      const uploads = performance.getEntriesByType("resource").filter((entry) => {
        try {
          return new URL(entry.name, location.href).pathname === "/profile/picture/upload/" &&
            entry.startTime >= startedAt;
        } catch {
          return false;
        }
      });
      const completed = uploads.filter((entry) => entry.responseEnd > 0);
      return {
        total: uploads.length,
        completed: completed.length,
        successful: completed.filter((entry) => entry.responseStatus >= 200 && entry.responseStatus < 300).length,
        failed: completed.filter((entry) => entry.responseStatus >= 400).length,
      };
    })()`);
    if (!value || typeof value !== "object" || !("total" in value) || typeof value.total !== "number" ||
        !("completed" in value) || typeof value.completed !== "number" ||
        !("successful" in value) || typeof value.successful !== "number" ||
        !("failed" in value) || typeof value.failed !== "number") {
      await delay(500);
      continue;
    }
    if (value.failed > 0) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[page-create] Facebook returned an error for a profile or cover image upload.", value);
      }
      return false;
    }
    if (value.completed !== lastCompletedCount && process.env.NODE_ENV !== "production") {
      console.info(`[page-create] Facebook image uploads completed: ${value.completed} of 2.`);
      lastCompletedCount = value.completed;
    }
    if (value.total >= 2 && value.completed >= 2 && value.successful >= 2) {
      if (process.env.NODE_ENV !== "production") {
        console.info("[page-create] Facebook confirmed successful profile and cover image upload responses.");
      }
      return true;
    }
    await delay(500);
  }
  if (process.env.NODE_ENV !== "production") {
    console.warn("[page-create] Facebook did not confirm both image uploads before the wait timed out.");
  }
  return false;
}

async function uploadPageImages(command: CdpCommand, images: PageImages) {
  await command("DOM.enable", {});
  // Facebook can accept Create Page immediately but take a while to render the
  // profile setup dialog after Next. Keep waiting for the actual file inputs
  // instead of treating a slow SPA transition as a missing upload step.
  const uploadDeadline = Date.now() + 90_000;
  let profileInputIndex: number | undefined;
  let coverInputIndex: number | undefined;
  while (Date.now() < uploadDeadline) {
    let inputStates: unknown;
    try {
      inputStates = await evaluatePageScript(command, `(() => [...document.querySelectorAll('input[type="file"][accept*="image"]')]
        .map((input, index) => {
          let container = input.parentElement;
          for (let depth = 0; container && depth < 12; depth++, container = container.parentElement) {
            const text = (container.innerText || "").toLowerCase();
            if (text.includes("add profile picture")) return { index, kind: "profile" };
            if (text.includes("add cover photo")) return { index, kind: "cover" };
          }
          return { index, kind: "unknown" };
        }))()`);
    } catch (error) {
      if (!isTransientExecutionContextError(error)) throw error;
      await delay(400);
      continue;
    }
    if (Array.isArray(inputStates)) {
      for (const inputState of inputStates) {
        if (!inputState || typeof inputState !== "object" || !("index" in inputState) ||
            typeof inputState.index !== "number" || !("kind" in inputState)) continue;
        if (inputState.kind === "profile") profileInputIndex = inputState.index;
        if (inputState.kind === "cover") coverInputIndex = inputState.index;
      }
    }
    if (profileInputIndex !== undefined && coverInputIndex !== undefined &&
        profileInputIndex !== coverInputIndex) break;
    profileInputIndex = undefined;
    coverInputIndex = undefined;
    await delay(400);
  }
  if (profileInputIndex === undefined || coverInputIndex === undefined) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[page-create] Facebook's profile setup upload inputs were still unavailable 90 seconds after Next.");
    }
    return false;
  }

  const documentResponse = await command("DOM.getDocument", { depth: -1, pierce: true });
  const rootNodeId = documentResponse.result?.root?.nodeId;
  if (!rootNodeId) throw new Error("Facebook's image upload document could not be accessed.");
  const inputResponse = await command("DOM.querySelectorAll", {
    nodeId: rootNodeId,
    selector: 'input[type="file"][accept*="image"]',
  });
  const inputNodeIds = inputResponse.result?.nodeIds;
  if (!inputNodeIds || profileInputIndex >= inputNodeIds.length || coverInputIndex >= inputNodeIds.length) return false;

  const extensions: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp",
    "image/tiff": "tif",
    "image/heic": "heic",
    "image/heif": "heif",
    "image/avif": "avif",
  };
  const profileExtension = extensions[images.profileImageType.toLowerCase()];
  const coverExtension = extensions[images.coverImageType.toLowerCase()];
  if (!profileExtension || !coverExtension) {
    throw new Error("Use JPEG, PNG, WebP, GIF, BMP, TIFF, HEIC, HEIF, or AVIF images for the profile and cover.");
  }

  const imageDirectory = await mkdtemp(path.join(os.tmpdir(), "kartstudio-page-images-"));
  try {
    const profileImagePath = path.join(imageDirectory, `profile.${profileExtension}`);
    const coverImagePath = path.join(imageDirectory, `cover.${coverExtension}`);
    await Promise.all([
      writeFile(profileImagePath, images.profileImage, { flag: "wx" }),
      writeFile(coverImagePath, images.coverImage, { flag: "wx" }),
    ]);
  const uploadStartedAt = await evaluatePageScript(command, "performance.now()");
  if (typeof uploadStartedAt !== "number") {
    throw new Error("Facebook image upload timing could not be observed.");
  }
    await command("DOM.setFileInputFiles", {
      nodeId: inputNodeIds[profileInputIndex],
      files: [profileImagePath],
    });
    await command("DOM.setFileInputFiles", {
      nodeId: inputNodeIds[coverInputIndex],
      files: [coverImagePath],
    });
    if (process.env.NODE_ENV !== "production") {
      console.info("[page-create] Submitted profile and cover images to Facebook; waiting for upload responses.");
    }
    // Facebook can clear or replace these file inputs as it consumes the files,
    // so checking input.files after selection can report a false failure even
    // while the uploaded previews and requests are already successful.
    // Await before finally removes the image files: Cent may still be reading
    // them while Facebook's upload requests are in flight.
    return await waitForFacebookPageImageUploads(command, uploadStartedAt);
  } finally {
    await removeTemporaryPageImages(imageDirectory);
  }
}

export async function populateAndSubmitFacebookLogin(
  profilePath: string,
  credentials: Credentials | null,
  bounds: WindowBounds,
): Promise<"authenticated" | "session-reused" | "login-required" | "unverified"> {
  const targetDeadline = Date.now() + TARGET_WAIT_MS;
  let target: DevToolsTarget | null = null;
  while (Date.now() < targetDeadline && !target) {
    target = await getFacebookTarget(profilePath);
    if (!target) await delay(300);
  }
  if (!target?.webSocketDebuggerUrl) {
    throw new Error("Cent did not expose its local automation endpoint.");
  }

  const socket = await connect(target.webSocketDebuggerUrl);
  try {
    let commandId = 0;
    await sendCommand(socket, ++commandId, "Page.enable", {});
    await sendCommand(socket, ++commandId, "Runtime.enable", {});
    const windowResponse = await sendCommand(socket, ++commandId, "Browser.getWindowForTarget", {});
    const windowId = windowResponse.result?.windowId;
    if (typeof windowId !== "number") throw new Error("Cent did not provide a controllable browser window.");
    await sendCommand(socket, ++commandId, "Browser.setWindowBounds", {
      windowId,
      bounds: { ...bounds, windowState: "normal" },
    });
    const formDeadline = Date.now() + FORM_WAIT_MS;
    let populated = false;
    let sessionReused = false;
    while (Date.now() < formDeadline && !populated) {
      let pageStateResponse: CdpResponse;
      try {
        pageStateResponse = await sendCommand(socket, ++commandId, "Runtime.evaluate", {
          expression: `(() => {
            if (document.readyState !== "complete") return "loading";
            if (/\\/checkpoint|\\/two_factor|\\/recover/i.test(location.pathname)) return "checkpoint";
            const email = document.querySelector('input[name="email"], #email');
            const password = document.querySelector('input[name="pass"], #pass');
            if (email instanceof HTMLInputElement && password instanceof HTMLInputElement) return "login";
            const loggedInMarker = document.querySelector(
              'a[href="/me/"], [aria-label="Account"], [aria-label="Your profile"], [data-pagelet="ProfileTilesFeed_0"]'
            );
            return loggedInMarker ? "authenticated" : "loading";
          })()`,
          returnByValue: true,
        });
      } catch (error) {
        if (!isTransientExecutionContextError(error)) throw error;
        await delay(500);
        continue;
      }
      if (pageStateResponse.result?.exceptionDetails) {
        throw new Error("Facebook page state could not be checked.");
      }
      const pageState = pageStateResponse.result?.result?.value;
      if (pageState === "authenticated") {
        sessionReused = true;
        break;
      }
      if (pageState === "checkpoint") {
        await restoreCentWindow(profilePath, bounds);
        return "login-required";
      }
      if (pageState !== "login") {
        await delay(500);
        continue;
      }
      if (!credentials) {
        await restoreCentWindow(profilePath, bounds);
        return "login-required";
      }
      if (!credentials.username || !credentials.password) {
        throw new Error("This account does not have a complete username and password.");
      }
      const credentialLiteral = JSON.stringify(credentials);
      const fillExpression = `(() => {
        if (document.readyState !== "complete") return false;
        const email = document.querySelector('input[name="email"], #email');
        const password = document.querySelector('input[name="pass"], #pass');
        if (!(email instanceof HTMLInputElement) || !(password instanceof HTMLInputElement) ||
            !email.isConnected || !password.isConnected || email.disabled || password.disabled) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (!setter) return false;
        const values = ${credentialLiteral};
        setter.call(email, values.username);
        email.dispatchEvent(new Event("input", { bubbles: true }));
        email.dispatchEvent(new Event("change", { bubbles: true }));
        setter.call(password, values.password);
        password.dispatchEvent(new Event("input", { bubbles: true }));
        password.dispatchEvent(new Event("change", { bubbles: true }));
        return email.value === values.username && password.value === values.password;
      })()`;
      let fillResponse: CdpResponse;
      try {
        fillResponse = await sendCommand(socket, ++commandId, "Runtime.evaluate", {
          expression: fillExpression,
          returnByValue: true,
        });
      } catch (error) {
        if (isTransientExecutionContextError(error)) { await delay(500); continue; }
        throw error;
      }
      if (fillResponse.result?.exceptionDetails) {
        throw new Error("Facebook rejected the credential population script.");
      }
      populated = fillResponse.result?.result?.value === true;
      if (!populated) await delay(300);
    }
    if (sessionReused) {
      try {
        await restoreCentWindow(profilePath, bounds);
      } catch (error) {
        console.error(`[facebook-login] Profile window positioning failed while reusing its saved session (${error instanceof Error ? error.message : "Unknown error"}).`);
      }
      return "session-reused";
    }
    if (!populated) throw new Error("Facebook's login form was not available.");
    if (!credentials) throw new Error("No imported credentials are available for this login form.");

    const submitExpression = `(() => {
      if (location.hostname !== "facebook.com" && !location.hostname.endsWith(".facebook.com")) return false;
      const email = document.querySelector('input[name="email"], #email');
      const password = document.querySelector('input[name="pass"], #pass');
      if (!(email instanceof HTMLInputElement) || !(password instanceof HTMLInputElement) ||
          email.form !== password.form || !email.form ||
          email.value !== ${JSON.stringify(credentials.username)} ||
          password.value !== ${JSON.stringify(credentials.password)}) return false;
      const submit = email.form.querySelector('button[name="login"], input[name="login"], button[type="submit"], input[type="submit"]');
      if (!(submit instanceof HTMLButtonElement) && !(submit instanceof HTMLInputElement)) return false;
      email.form.requestSubmit(submit);
      return true;
    })()`;
    let submitWasAccepted = false;
    try {
      const submitResponse = await sendCommand(socket, ++commandId, "Runtime.evaluate", {
        expression: submitExpression,
        returnByValue: true,
      });
      if (submitResponse.result?.exceptionDetails) {
        throw new Error("Facebook's populated login form could not be submitted.");
      }
      submitWasAccepted = submitResponse.result?.result?.value === true;
    } catch (error) {
      if (!isTransientExecutionContextError(error)) throw error;
      // Facebook may destroy the form's execution context immediately after navigation starts.
      submitWasAccepted = true;
    }
    if (!submitWasAccepted) {
      throw new Error("Facebook's populated login form could not be submitted.");
    }

    const resultDeadline = Date.now() + LOGIN_RESULT_WAIT_MS;
    let loginFormSince: number | null = null;
    while (Date.now() < resultDeadline) {
      let response: CdpResponse;
      try {
        response = await sendCommand(socket, ++commandId, "Runtime.evaluate", {
          expression: `(() => {
            if (document.readyState !== "complete") return "loading";
            if (/\\/checkpoint|\\/two_factor|\\/recover/i.test(location.pathname)) return "checkpoint";
            const email = document.querySelector('input[name="email"], #email');
            const password = document.querySelector('input[name="pass"], #pass');
            if (email instanceof HTMLInputElement && password instanceof HTMLInputElement) return "login";
            const loggedInMarker = document.querySelector(
              'a[href="/me/"], [aria-label="Account"], [aria-label="Your profile"], [data-pagelet="ProfileTilesFeed_0"]'
            );
            return loggedInMarker ? "authenticated" : "loading";
          })()`,
          returnByValue: true,
        });
      } catch (error) {
        if (isTransientExecutionContextError(error)) { await delay(500); continue; }
        throw error;
      }
      if (response.result?.exceptionDetails) {
        throw new Error("Facebook's post-submit page state could not be checked.");
      }
      const pageState = response.result?.result?.value;
      if (pageState === "authenticated") {
        try {
          await restoreCentWindow(profilePath, bounds);
        } catch (error) {
          console.error(`[facebook-login] Profile window positioning failed after authentication (${error instanceof Error ? error.message : "Unknown error"}).`);
        }
        return "authenticated";
      }
      if (pageState === "checkpoint") {
        try {
          await restoreCentWindow(profilePath, bounds);
        } catch (error) {
          console.error(`[facebook-login] Profile window positioning failed at a Facebook checkpoint (${error instanceof Error ? error.message : "Unknown error"}).`);
        }
        return "login-required";
      }
      if (pageState === "login") {
        loginFormSince ??= Date.now();
        if (Date.now() - loginFormSince >= 6_000) {
          try {
            await restoreCentWindow(profilePath, bounds);
          } catch (error) {
            console.error(`[facebook-login] Profile window positioning failed after Facebook kept the login form open (${error instanceof Error ? error.message : "Unknown error"}).`);
          }
          return "login-required";
        }
      } else {
        loginFormSince = null;
      }
      await delay(500);
    }
    try {
      await restoreCentWindow(profilePath, bounds);
    } catch (error) {
      console.error(`[facebook-login] Profile window positioning failed while awaiting Facebook's login result (${error instanceof Error ? error.message : "Unknown error"}).`);
    }
    return "unverified";
  } finally {
    socket.close();
  }
}

/** Wait for a user to finish a Facebook sign-in/checkpoint in the already-open Cent profile. */
export async function waitForFacebookAuthentication(profilePath: string, timeoutMs = 5 * 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const target = await getFacebookTarget(profilePath);
    if (target?.webSocketDebuggerUrl) {
      let socket: WebSocket | null = null;
      try {
        socket = await connect(target.webSocketDebuggerUrl);
        await sendCommand(socket, 1, "Runtime.enable", {});
        const response = await sendCommand(socket, 2, "Runtime.evaluate", {
          expression: `(() => {
            if (document.readyState !== "complete") return "loading";
            if (/\\/checkpoint|\\/two_factor|\\/recover/i.test(location.pathname)) return "waiting";
            const email = document.querySelector('input[name="email"], #email');
            const password = document.querySelector('input[name="pass"], #pass');
            if (email instanceof HTMLInputElement && password instanceof HTMLInputElement) return "waiting";
            const loggedInMarker = document.querySelector(
              'a[href="/me/"], [aria-label="Account"], [aria-label="Your profile"], [data-pagelet="ProfileTilesFeed_0"]'
            );
            return loggedInMarker ? "authenticated" : "loading";
          })()`,
          returnByValue: true,
        });
        if (response.result?.result?.value === "authenticated") return true;
      } catch (error) {
        if (!isTransientExecutionContextError(error)) {
          console.warn(`[facebook-login] Could not check the Cent profile while waiting for manual sign-in: ${error instanceof Error ? error.message : "Unknown error"}`);
        }
      } finally {
        socket?.close();
      }
    }
    await delay(1_000);
  }
  return false;
}

export async function populateFacebookPageForm(
  profilePath: string,
  details: PageDetails,
  images: PageImages,
  options: { stopBeforeCreate?: boolean } = {},
): Promise<"images-uploaded" | "completion-unconfirmed" | "setup-ready-for-review" | "next-clicked" | "created-clicked" | "login-required" | "checkpoint" | "category-unselected" | "create-button-unavailable" | "next-button-unavailable" | "image-upload-unavailable" | "post-upload-step-unavailable" | "fields-unverified" | "category-unverified" | "form-unavailable"> {
  const targetDeadline = Date.now() + TARGET_WAIT_MS;
  let target: DevToolsTarget | null = null;
  let knownTargets: DevToolsTarget[] = [];
  while (Date.now() < targetDeadline && !target) {
    knownTargets = await getFacebookTargets(profilePath);
    target = knownTargets[0] ?? null;
    if (!target) await delay(300);
  }
  if (!target?.webSocketDebuggerUrl) {
    throw new Error("Cent did not expose its local Facebook automation endpoint.");
  }

  let socket = await connect(target.webSocketDebuggerUrl);
  const originalSocket = socket;
  let stopNetworkObservation = () => {};
  try {
    let commandId = 0;
    const command: CdpCommand = (method, params) => sendCommand(socket, ++commandId, method, params);
    await sendCommand(socket, ++commandId, "Page.enable", {});
    await sendCommand(socket, ++commandId, "Runtime.enable", {});

    const currentState = await sendCommand(socket, ++commandId, "Runtime.evaluate", {
      expression: `(() => {
        if (/\\/checkpoint|\\/two_factor|\\/recover/i.test(location.pathname)) return "checkpoint";
        if (document.querySelector('input[name="email"], #email, input[name="pass"], #pass')) return "login";
        return "ready-to-navigate";
      })()`,
      returnByValue: true,
    });
    if (currentState.result?.exceptionDetails) throw new Error("Facebook session state could not be checked.");
    const state = currentState.result?.result?.value;
    if (state === "checkpoint") return "checkpoint";
    if (state === "login") return "login-required";
    if (state !== "ready-to-navigate") {
      throw new Error("Facebook returned an unexpected session state before opening the Page form.");
    }

    const navigation = await sendCommand(socket, ++commandId, "Page.navigate", {
      url: "https://www.facebook.com/pages/creation/",
    });
    if (navigation.result?.exceptionDetails) throw new Error("Cent could not open Facebook's Page creation form.");

    const fieldStateExpression = `(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
      };
      const controls = [...document.querySelectorAll('input:not([type="hidden"]):not([type="file"]), textarea, [role="textbox"], [role="combobox"], [contenteditable="true"]')].filter(visible);
      const fieldText = (element) => [
        element.getAttribute("aria-label"),
        element.getAttribute("placeholder"),
        element.labels ? [...element.labels].map((label) => label.innerText).join(" ") : "",
        element.closest("label")?.innerText,
      ].filter(Boolean).join(" ").trim().toLowerCase();
      const labels = [...document.querySelectorAll("label")].filter((label) => visible(label));
      const labelMatches = (label, pattern) => [...label.querySelectorAll("span")]
        .some((span) => pattern.test(span.innerText.trim().toLowerCase()));
      const hasField = (pattern) => controls.some((element) => pattern.test(fieldText(element))) ||
        labels.some((label) => labelMatches(label, pattern) &&
          (label.control || label.querySelector('input, textarea, [role="textbox"], [role="combobox"], [contenteditable="true"]')));
      return hasField(/^page\\s*name(?:\\s*\\(required\\))?$/) &&
        hasField(/^category(?:\\s*\\(required\\))?$/) &&
        hasField(/^bio(?:\\s*\\(optional\\))?$/) ? "form" : "loading";
    })()`;
    const deadline = Date.now() + FORM_WAIT_MS;
    let categoryQueryWritten = false;
    while (Date.now() < deadline) {
      let response: CdpResponse;
      try {
        response = await sendCommand(socket, ++commandId, "Runtime.evaluate", {
          expression: `(() => {
            if (/\\/checkpoint|\\/two_factor|\\/recover/i.test(location.pathname)) return "checkpoint";
            if (document.querySelector('input[name="email"], #email, input[name="pass"], #pass')) return "login";
            return (${fieldStateExpression}) === "form" ? "form" : "loading";
          })()`,
          returnByValue: true,
        });
      } catch (error) {
        if (isTransientExecutionContextError(error)) { await delay(500); continue; }
        throw error;
      }
      if (response.result?.exceptionDetails) throw new Error("Facebook Page form state could not be checked.");
      const pageState = response.result?.result?.value;
      if (pageState === "checkpoint") return "checkpoint";
      if (pageState === "login") return "login-required";
      if (pageState !== "form") { await delay(500); continue; }

      const writeCategoryThisPass = !categoryQueryWritten;
      categoryQueryWritten = true;
      const fillExpression = `(() => {
        const values = ${JSON.stringify(details)};
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
        };
        const controls = [...document.querySelectorAll('input:not([type="hidden"]):not([type="file"]), textarea, [role="textbox"], [role="combobox"], [contenteditable="true"]')].filter(visible);
        const fieldText = (element) => [
          element.getAttribute("aria-label"),
          element.getAttribute("placeholder"),
          element.labels ? [...element.labels].map((label) => label.innerText).join(" ") : "",
          element.closest("label")?.innerText,
        ].filter(Boolean).join(" ").trim().toLowerCase();
        const findField = (pattern) => {
          const direct = controls.find((element) => pattern.test(fieldText(element)));
          if (direct) return direct;
          const label = [...document.querySelectorAll("label")].find((candidate) => visible(candidate) &&
            [...candidate.querySelectorAll("span")].some((span) =>
              pattern.test(span.innerText.trim().toLowerCase())));
          return label?.control ??
            label?.querySelector('input, textarea, [role="textbox"], [role="combobox"], [contenteditable="true"]');
        };
        const name = findField(/^page\\s*name(?:\\s*\\(required\\))?$/);
        const category = findField(/^category(?:\\s*\\(required\\))?$/);
        const bio = findField(/^bio(?:\\s*\\(optional\\))?$/);
        if (!name || !category || !bio) return false;
        const setValue = (field, value) => {
          if (field instanceof HTMLInputElement) {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
            if (!setter) return false;
            setter.call(field, value);
          } else if (field instanceof HTMLTextAreaElement) {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
            if (!setter) return false;
            setter.call(field, value);
          } else if (field.isContentEditable) {
            field.focus();
            field.textContent = value;
          } else {
            return false;
          }
          field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
          field.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        };
        const readValue = (field) => field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
          ? field.value
          : field.textContent?.trim() ?? "";
        if (readValue(name) !== values.name && !setValue(name, values.name)) return false;
        if (readValue(bio) !== values.bio && !setValue(bio, values.bio)) return false;
        const currentCategory = document.querySelector('input[aria-label="Category (required)"]') ?? category;
        if (${writeCategoryThisPass} && readValue(currentCategory) !== values.category &&
            !setValue(currentCategory, values.category)) return false;
        const currentName = findField(/^page\\s*name(?:\\s*\\(required\\))?$/);
        const currentBio = findField(/^bio(?:\\s*\\(optional\\))?$/);
        const latestCategory = document.querySelector('input[aria-label="Category (required)"]') ??
          findField(/^category(?:\\s*\\(required\\))?$/);
        return Boolean(currentName && currentBio && latestCategory) &&
          readValue(currentName) === values.name &&
          readValue(latestCategory) === values.category &&
          readValue(currentBio) === values.bio;
      })()`;
      let fillResponse: CdpResponse;
      try {
        fillResponse = await sendCommand(socket, ++commandId, "Runtime.evaluate", {
          expression: fillExpression,
          returnByValue: true,
        });
      } catch (error) {
        if (isTransientExecutionContextError(error)) { await delay(500); continue; }
        throw error;
      }
      if (fillResponse.result?.exceptionDetails) throw new Error("Facebook Page form population script failed.");
      if (fillResponse.result?.result?.value !== true) { await delay(500); continue; }

      // Let Facebook settle validation and rerender after long or emoji-heavy bios.
      await delay(1_500);
      const normalizeCategory = (value: string) => value.normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const expectedCategory = normalizeCategory(details.category);
      let categorySelected = false;
      for (let attempt = 1; attempt <= 3 && !categorySelected; attempt++) {
        const field = await evaluatePageScript(command, `(() => {
          const input = document.querySelector('input[aria-label^="Category"]');
          if (!(input instanceof HTMLInputElement)) return null;
          const rect = input.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        })()`);
        if (!field || typeof field !== "object" || !("x" in field) || typeof field.x !== "number" ||
            !("y" in field) || typeof field.y !== "number") {
          await delay(300);
          continue;
        }

        await clickWithNativeInput(command, field.x, field.y);
        await command("Input.dispatchKeyEvent", {
          type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65,
        });
        await command("Input.dispatchKeyEvent", {
          type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65,
        });
        await command("Input.insertText", { text: details.category });
        await delay(750);

        const suggestions = await evaluatePageScript(command, `(() => {
          const input = document.querySelector('input[aria-label^="Category"]');
          if (!(input instanceof HTMLInputElement)) return { options: [], active: "", expanded: false };
          const listboxId = input.getAttribute("aria-controls");
          const listbox = (listboxId && document.getElementById(listboxId)) || document.querySelector('[role="listbox"]');
          const visible = (option) => {
            const rect = option.getBoundingClientRect();
            const style = getComputedStyle(option);
            return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" &&
              style.display !== "none" && option.getClientRects().length > 0;
          };
          const options = [...(listbox?.querySelectorAll('[role="option"]') ?? [])]
            .filter(visible).map((option) => ({ text: option.innerText.trim(), id: option.id }));
          const activeId = input.getAttribute("aria-activedescendant");
          const activeOption = activeId ? document.getElementById(activeId) :
            listbox?.querySelector('[role="option"][aria-selected="true"]');
          return {
            options,
            active: activeOption && visible(activeOption) ? activeOption.innerText.trim() : "",
            expanded: input.getAttribute("aria-expanded") === "true",
          };
        })()`);
        if (!suggestions || typeof suggestions !== "object" || !("options" in suggestions) ||
            !Array.isArray(suggestions.options)) continue;
        const optionTexts = suggestions.options.flatMap((option) =>
          option && typeof option === "object" && "text" in option && typeof option.text === "string" ? [option.text] : []);
        const exactOption = optionTexts.find((text) => normalizeCategory(text) === expectedCategory);
        if (process.env.NODE_ENV !== "production") {
          console.info("[page-create] Category selection attempt", {
            attempt,
            query: details.category,
            options: optionTexts,
            active: "active" in suggestions ? suggestions.active : "",
          });
        }
        if (!exactOption) continue;

        await command("Input.dispatchKeyEvent", {
          type: "keyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40,
        });
        await command("Input.dispatchKeyEvent", {
          type: "keyUp", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40,
        });
        const active = await evaluatePageScript(command, `(() => {
          const input = document.querySelector('input[aria-label^="Category"]');
          const listboxId = input?.getAttribute("aria-controls");
          const listbox = (listboxId && document.getElementById(listboxId)) || document.querySelector('[role="listbox"]');
          const activeId = input?.getAttribute("aria-activedescendant");
          const option = activeId ? document.getElementById(activeId) :
            listbox?.querySelector('[role="option"][aria-selected="true"]');
          return option?.innerText.trim() || "";
        })()`);

        if (typeof active === "string" && normalizeCategory(active) === expectedCategory) {
          await command("Input.dispatchKeyEvent", {
            type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13,
          });
          await command("Input.dispatchKeyEvent", {
            type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13,
          });
        } else {
          const exactTarget = await evaluatePageScript(command, `(() => {
            const normalize = (value) => (value || "").normalize("NFKD").replace(/[\\u0300-\\u036f]/g, "")
              .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
            const wanted = normalize(${JSON.stringify(details.category)});
            const input = document.querySelector('input[aria-label^="Category"]');
            const listboxId = input?.getAttribute("aria-controls");
            const listbox = (listboxId && document.getElementById(listboxId)) || document.querySelector('[role="listbox"]');
            const option = [...(listbox?.querySelectorAll('[role="option"]') ?? [])].find((item) => normalize(item.innerText) === wanted);
            if (!option) return null;
            option.scrollIntoView({ block: "nearest" });
            const rect = option.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          })()`);
          if (exactTarget && typeof exactTarget === "object" && "x" in exactTarget && typeof exactTarget.x === "number" &&
              "y" in exactTarget && typeof exactTarget.y === "number") {
            await clickWithNativeInput(command, exactTarget.x, exactTarget.y);
          }
        }

        const chipDeadline = Date.now() + 1_500;
        while (Date.now() < chipDeadline) {
          const chips = await evaluatePageScript(command, `(() => [...document.querySelectorAll('[aria-label="Selected values"] [role="listitem"]')]
            .map((element) => element.innerText.trim()).filter(Boolean))()`);
          if (Array.isArray(chips) && chips.some((chip) => typeof chip === "string" && normalizeCategory(chip) === expectedCategory)) {
            categorySelected = true;
            break;
          }
          await delay(200);
        }
      }
      if (!categorySelected) return "category-unselected";

      const categoryDeadline = Date.now() + 8_000;
      let categoryKeyboardSelectSent = false;
      while (Date.now() < categoryDeadline) {
        let categoryResponse: CdpResponse;
        try {
          categoryResponse = await sendCommand(socket, ++commandId, "Runtime.evaluate", {
            expression: `(async () => {
              const input = document.querySelector('input[aria-label="Category (required)"]');
              if (!input) return { state: "missing" };
              const query = input.value.trim();
              const selectedValues = () => [...document.querySelectorAll('[aria-label="Selected values"] [role="listitem"]')]
                .map((element) => element.innerText.trim()).filter(Boolean);
              const existing = selectedValues();
              if (existing.length) return { state: "selected", query, choices: [], target: existing[0], selected: existing };
              const listboxId = input.getAttribute("aria-controls");
              const getOptions = () => {
                const listbox = (listboxId && document.getElementById(listboxId)) || document.querySelector('[role="listbox"]');
                return [...(listbox?.querySelectorAll('[role="option"]') ?? [])].filter((option) => {
                  const rect = option.getBoundingClientRect();
                  const style = getComputedStyle(option);
                  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" &&
                    style.display !== "none" && option.getClientRects().length > 0;
                });
              };
              let options = getOptions();
              if (!options.length) {
                input.focus();
                await new Promise((resolve) => setTimeout(resolve, 350));
                options = getOptions();
              }
              if (!options.length) {
                const rect = input.getBoundingClientRect();
                return { state: "needs-focus", query, choices: [], selected: [], x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
              }
              if (!${categoryKeyboardSelectSent}) {
                return { state: "keyboard-select", query, choices: options.map((option) => option.innerText.trim()), expanded: true };
              }
              return { state: "waiting", query, choices: options.map((option) => option.innerText.trim()), selected: [], expanded: true, inputValue: input.value };
            })()`,
            awaitPromise: true,
            returnByValue: true,
          });
        } catch (error) {
          if (isTransientExecutionContextError(error)) { await delay(300); continue; }
          throw error;
        }
        if (categoryResponse.result?.exceptionDetails) throw new Error("Facebook category suggestions could not be read.");
        const categoryResult = categoryResponse.result?.result?.value;
        if (categoryResult && typeof categoryResult === "object" && "state" in categoryResult) {
          if (process.env.NODE_ENV !== "production" && "query" in categoryResult) {
            console.info("[page-create] Category suggestion selection", {
              query: categoryResult.query,
              choices: "choices" in categoryResult ? categoryResult.choices : [],
              selected: "target" in categoryResult ? categoryResult.target : null,
              chips: "selected" in categoryResult ? categoryResult.selected : [],
              state: categoryResult.state,
            });
          }
          if (categoryResult.state === "keyboard-select" && !categoryKeyboardSelectSent) {
            for (const [key, code, virtualKey] of [["ArrowDown", "ArrowDown", 40], ["Enter", "Enter", 13]] as const) {
              await command("Input.dispatchKeyEvent", {
                type: "keyDown",
                key,
                code,
                windowsVirtualKeyCode: virtualKey,
                nativeVirtualKeyCode: virtualKey,
              });
              await command("Input.dispatchKeyEvent", {
                type: "keyUp",
                key,
                code,
                windowsVirtualKeyCode: virtualKey,
                nativeVirtualKeyCode: virtualKey,
              });
            }
            categoryKeyboardSelectSent = true;
            await delay(500);
          }
          if (categoryResult.state === "needs-focus" && "x" in categoryResult && typeof categoryResult.x === "number" &&
              "y" in categoryResult && typeof categoryResult.y === "number") {
            await clickWithNativeInput(command, categoryResult.x, categoryResult.y);
            await delay(350);
          }
          if (categoryResult.state === "selected") {
            // Re-enter the Page bio through the browser's real input path after
            // category selection. Facebook can display a script-set DOM value
            // without committing it to the controlled form state.
            const bioCommitted = await commitPageBioWithKeyboard(command, details.bio);
            if (!bioCommitted) {
              if (process.env.NODE_ENV !== "production") {
                console.warn("[page-create] Bio did not survive keyboard entry and blur; refusing to submit.");
              }
              return "fields-unverified";
            }

            const readyCheck = await sendCommand(socket, ++commandId, "Runtime.evaluate", {
              expression: `(() => {
                const expected = ${JSON.stringify(details)};
                const normalize = (value) => (value || "").normalize("NFKD").replace(/[\\u0300-\\u036f]/g, "")
                  .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
                const visible = (element) => {
                  const rect = element.getBoundingClientRect();
                  return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden" &&
                    element.offsetParent !== null;
                };
                const fields = [...document.querySelectorAll('input:not([type="hidden"]), textarea, [role="textbox"], [role="combobox"], [contenteditable="true"]')].filter(visible);
                const fieldText = (element) => {
                  const labelText = element.labels ? [...element.labels]
                    .flatMap((label) => [...label.querySelectorAll("span")].map((span) => span.innerText.trim()))
                    .find(Boolean) : "";
                  return (element.getAttribute("aria-label") || element.getAttribute("placeholder") ||
                    labelText || element.closest("label")?.innerText || "").trim().toLowerCase();
                };
                const findField = (pattern) => {
                  const direct = fields.find((field) => pattern.test(fieldText(field)));
                  if (direct) return direct;
                  const label = [...document.querySelectorAll("label")].find((candidate) => visible(candidate) &&
                    [...candidate.querySelectorAll("span")].some((span) =>
                      pattern.test(span.innerText.trim().toLowerCase())));
                  return label?.control ??
                    label?.querySelector('input, textarea, [role="textbox"], [role="combobox"], [contenteditable="true"]');
                };
                const normalizeValue = (value) => (value || "").replace(/\\u00a0/g, " ")
                  .replace(/\\r\\n?/g, "\\n").replace(/[ \\t]+/g, " ").trim();
                const valueOf = (field) => normalizeValue(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
                  ? field.value
                  : field instanceof HTMLElement && field.isContentEditable ? field.innerText : field.innerText || field.textContent || "");
                const name = findField(/^page\\s*name(?:\\s*\\(required\\))?$/);
                const bio = findField(/^bio(?:\\s*\\(optional\\))?$/);
                const nameMatches = Boolean(name && valueOf(name) === normalizeValue(expected.name));
                const bioMatches = Boolean(bio && valueOf(bio) === normalizeValue(expected.bio));
                const category = [...document.querySelectorAll('[aria-label="Selected values"] [role="listitem"]')]
                  .map((element) => element.innerText.trim()).filter(Boolean);
                if (!name || valueOf(name) !== normalizeValue(expected.name) || !bio || valueOf(bio) !== normalizeValue(expected.bio)) {
                  return {
                    state: "fields-unverified",
                    nameFound: Boolean(name),
                    nameMatches: Boolean(name && valueOf(name) === expected.name),
                    bioFound: Boolean(bio),
                    bioMatches: Boolean(bio && valueOf(bio) === expected.bio),
                  };
                }
                if (category.length === 0) {
                  return { state: "category-unverified", selectedCategories: category };
                }
                return { state: "ready" };
              })()`,
              returnByValue: true,
            });
            if (readyCheck.result?.exceptionDetails) throw new Error("Facebook Page details could not be verified before creation.");
            const readyState = readyCheck.result?.result?.value;
            if (!readyState || typeof readyState !== "object" || !("state" in readyState) || readyState.state !== "ready") {
              if (process.env.NODE_ENV !== "production") {
                console.warn("[page-create] Readiness verification failed", readyState);
              }
              if (readyState && typeof readyState === "object" && "state" in readyState &&
                  (readyState.state === "fields-unverified" || readyState.state === "category-unverified")) {
                return readyState.state;
              }
              throw new Error("Facebook Page details could not be verified before creation. The Create Page button was not clicked.");
            }

            if (options.stopBeforeCreate) {
              if (process.env.NODE_ENV !== "production") {
                console.info("[page-create] Test mode: details verified; stopped before clicking Create Page.");
              }
              return "setup-ready-for-review";
            }

            await delay(2_000);

            await command("Network.enable", {});
            const networkObserver = observePageNetwork(socket);
            stopNetworkObservation = networkObserver.dispose;
            const createResult = await clickCreatePageButton(command, details);
            if (createResult === "fields-unverified") return "fields-unverified";
            if (createResult === "category-unverified") return "category-unverified";
            if (createResult !== "clicked") return "create-button-unavailable";

            // Facebook may open the newly created Page flow in another tab.
            // Wait for either the same tab's Next control or a new
            // Facebook target, then direct the rest of the automation there.
            const knownTargetIds = new Set(knownTargets.flatMap((item) => item.id ? [item.id] : []));
            // Facebook can take several minutes to finish the create request before
            // it renders the setup flow. Keep watching both the current tab and
            // newly opened Facebook tabs during that response window.
            const createdTarget = await waitForNewFacebookTarget(
              profilePath,
              knownTargetIds,
              command,
              PAGE_CREATE_RESPONSE_WAIT_MS,
            );
            if (createdTarget?.webSocketDebuggerUrl) {
              socket = await connect(createdTarget.webSocketDebuggerUrl);
              await sendCommand(socket, ++commandId, "Page.enable", {});
              await sendCommand(socket, ++commandId, "Runtime.enable", {});
              if (process.env.NODE_ENV !== "production") {
                console.info("[page-create] Switched automation to Facebook's newly opened Page setup tab.");
              }
            }

            // Use the actual upload controls to identify the photo step. If
            // Facebook is still on the success screen, click its visible Next
            // action first; do not depend on the localized step-counter text.
            let alreadyOnImageStep = false;
            try {
              alreadyOnImageStep = await hasFacebookPageImageUploadControls(command);
            } catch (error) {
              if (!isTransientExecutionContextError(error)) throw error;
            }
            if (!alreadyOnImageStep) {
              const initialNextClicked = await clickAvailablePageSetupAction(command, "Next", PAGE_CREATE_RESPONSE_WAIT_MS);
              if (!initialNextClicked) return "next-button-unavailable";
            }

            const imagesUploaded = await uploadPageImages(command, images);
            if (!imagesUploaded) return "image-upload-unavailable";
            await delay(2_000);
            const postUploadActions = ["Next", "Skip", "Next", "Done"] as const;
            for (let actionIndex = 0; actionIndex < postUploadActions.length; actionIndex++) {
              const expectedAction = postUploadActions[actionIndex];
              const action = await clickAvailablePageSetupAction(
                command,
                expectedAction,
                180_000,
                actionIndex === 0 ? PAGE_ACTION_STABLE_MS : 0,
              );
              if (!action) {
                if (process.env.NODE_ENV !== "production") {
                  console.warn(`[page-create] Facebook did not show an enabled ${expectedAction} action after image upload.`);
                }
                return "post-upload-step-unavailable";
              }
              if (expectedAction === "Done") {
                const completed = await waitForFacebookPageCreationCompletion(command, details.name);
                if (completed) return "images-uploaded";
                if (process.env.NODE_ENV !== "production") {
                  console.warn("[page-create] Facebook did not confirm the Page after Done; keeping this profile available for review.");
                }
                return "completion-unconfirmed";
              }
              const advanced = await waitForPageSetupProgress(
                command,
                action.label,
                action.beforeHeading,
                action.beforeStep,
              );
              if (!advanced) {
                if (process.env.NODE_ENV !== "production") {
                  console.warn(`[page-create] Facebook did not confirm a step change after ${expectedAction}.`);
                }
                return "post-upload-step-unavailable";
              }
            }
            return "post-upload-step-unavailable";
          }
          if (categoryResult.state === "missing") break;
        }
        await delay(300);
      }
      return "category-unselected";
    }
    return "form-unavailable";
  } finally {
    stopNetworkObservation();
    socket.close();
    if (originalSocket !== socket) originalSocket.close();
  }
}
