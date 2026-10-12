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
  result?: {
    result?: { value?: unknown };
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
const COMMAND_WAIT_MS = 10_000;
const execFileAsync = promisify(execFile);

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function getFacebookTarget(profilePath: string): Promise<DevToolsTarget | null> {
  let portFile: string;
  try {
    portFile = await readFile(path.join(profilePath, DEBUG_PORT_FILE), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }

  const port = Number(portFile.split(/\r?\n/)[0]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) });
  } catch (error) {
    if (error instanceof TypeError || error instanceof DOMException) return null;
    throw error;
  }
  if (!response.ok) return null;

  const targets = await response.json() as DevToolsTarget[];
  return targets.find((target) => {
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
  }) ?? null;
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

async function evaluatePageScript(command: CdpCommand, expression: string) {
  const response = await command("Runtime.evaluate", { expression, returnByValue: true });
  if (response.result?.exceptionDetails) throw new Error("Facebook Page browser script failed.");
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
    const fieldText = (element) => [
      element.getAttribute("aria-label"),
      element.getAttribute("placeholder"),
      element.labels ? [...element.labels].map((label) => label.innerText).join(" ") : "",
      element.closest("label")?.innerText,
    ].filter(Boolean).join(" ").trim().toLowerCase();
    const findField = (pattern) => {
      const direct = controls.find((field) => pattern.test(fieldText(field)));
      if (direct) return direct;
      const label = [...document.querySelectorAll("label")].find((candidate) => visible(candidate) &&
        [...candidate.querySelectorAll("span")].some((span) =>
          pattern.test(span.innerText.trim().toLowerCase())));
      return label?.control ??
        label?.querySelector('input, textarea, [role="textbox"], [role="combobox"], [contenteditable="true"]');
    };
    const valueOf = (field) => field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
      ? field.value.trim()
      : field.textContent?.trim() || "";
    const name = findField(/^page\\s*name(?:\\s*\\(required\\))?$/);
    const bio = findField(/^bio(?:\\s*\\(optional\\))?$/);
    const selected = [...document.querySelectorAll('[aria-label="Selected values"] [role="listitem"]')]
      .map((element) => element.innerText.trim());
    if (!name || valueOf(name) !== expected.name || !bio || valueOf(bio) !== expected.bio ||
        !selected.some((value) => normalize(value).includes(normalize(expected.category)))) {
      return { state: "fields-unverified" };
    }
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
  const first = await evaluatePageScript(command, clickExpression);
  if (!first || typeof first !== "object" || !("state" in first)) {
    throw new Error("Facebook Create Page click script returned an unexpected result.");
  }
  if (first.state === "fields-unverified") return "fields-unverified" as const;
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
      const fieldText = (element) => [
        element.getAttribute("aria-label"),
        element.getAttribute("placeholder"),
        element.labels ? [...element.labels].map((label) => label.innerText).join(" ") : "",
        element.closest("label")?.innerText,
      ].filter(Boolean).join(" ").trim().toLowerCase();
      const findField = (pattern) => {
        const direct = fields.find((field) => pattern.test(fieldText(field)));
        if (direct) return direct;
        const label = [...document.querySelectorAll("label")].find((candidate) => visible(candidate) &&
          [...candidate.querySelectorAll("span")].some((span) =>
            pattern.test(span.innerText.trim().toLowerCase())));
        return label?.control ??
          label?.querySelector('input, textarea, [role="textbox"], [role="combobox"], [contenteditable="true"]');
      };
      const valueOf = (field) => field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
        ? field.value.trim()
        : field.textContent?.trim() || "";
      const name = findField(/^page\\s*name(?:\\s*\\(required\\))?$/);
      const bio = findField(/^bio(?:\\s*\\(optional\\))?$/);
      const selected = [...document.querySelectorAll('[aria-label="Selected values"] [role="listitem"]')]
        .map((element) => element.innerText.trim());
      if (!name || valueOf(name) !== expected.name || !bio || valueOf(bio) !== expected.bio ||
          !selected.some((value) => normalize(value).includes(normalize(expected.category)))) {
        return { state: "fields-changed" };
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
    await clickWithNativeInput(command, retryState.x, retryState.y);
    if (process.env.NODE_ENV !== "production") {
      console.info("[page-create] Retried Create Page once because the button remained visible and enabled.");
    }
  }
  return "clicked" as const;
}

async function clickNextButton(command: CdpCommand) {
  await delay(2_500);
  const deadline = Date.now() + 7_000;
  while (Date.now() < deadline) {
    let state: unknown;
    try {
      state = await evaluatePageScript(command, `(() => {
        const button = [...document.querySelectorAll('[role="button"][aria-label="Next"]')]
          .find((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 &&
              getComputedStyle(element).visibility !== "hidden" &&
              getComputedStyle(element).display !== "none" && element.offsetParent !== null;
          });
        if (!button || button.getAttribute("aria-disabled") === "true" ||
            (button instanceof HTMLButtonElement && button.disabled)) return null;
        button.scrollIntoView({ block: "center" });
        const rect = button.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`);
    } catch (error) {
      if (!isTransientExecutionContextError(error)) throw error;
      await delay(400);
      continue;
    }
    if (state && typeof state === "object" && "x" in state && typeof state.x === "number" &&
        "y" in state && typeof state.y === "number") {
      await clickWithNativeInput(command, state.x, state.y);
      if (process.env.NODE_ENV !== "production") {
        console.info("[page-create] Clicked Facebook's Next button with native browser input.");
      }
      return true;
    }
    await delay(400);
  }
  return false;
}

async function uploadPageImages(command: CdpCommand, images: PageImages) {
  await command("DOM.enable", {});
  const uploadDeadline = Date.now() + 10_000;
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
  if (profileInputIndex === undefined || coverInputIndex === undefined) return false;

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
    await command("DOM.setFileInputFiles", {
      nodeId: inputNodeIds[profileInputIndex],
      files: [profileImagePath],
    });
    await command("DOM.setFileInputFiles", {
      nodeId: inputNodeIds[coverInputIndex],
      files: [coverImagePath],
    });

    const verificationDeadline = Date.now() + 5_000;
    while (Date.now() < verificationDeadline) {
      let attached: unknown;
      try {
        attached = await evaluatePageScript(command, `(() => {
          const inputs = [...document.querySelectorAll('input[type="file"][accept*="image"]')];
          const kindAt = (index) => {
            let container = inputs[index]?.parentElement;
            for (let depth = 0; container && depth < 12; depth++, container = container.parentElement) {
              const text = (container.innerText || "").toLowerCase();
              if (text.includes("add profile picture")) return "profile";
              if (text.includes("add cover photo")) return "cover";
            }
            return "unknown";
          };
          const result = {};
          inputs.forEach((input, index) => {
            const kind = kindAt(index);
            if (kind !== "unknown") result[kind] = input.files?.[0]?.name || "";
          });
          return result;
        })()`);
      } catch (error) {
        if (!isTransientExecutionContextError(error)) throw error;
        await delay(300);
        continue;
      }
      if (attached && typeof attached === "object" &&
          "profile" in attached && attached.profile === `profile.${profileExtension}` &&
          "cover" in attached && attached.cover === `cover.${coverExtension}`) {
        if (process.env.NODE_ENV !== "production") {
          console.info("[page-create] Attached profile and cover images to Facebook's upload controls.");
        }
        return true;
      }
      await delay(300);
    }
    throw new Error("Facebook did not confirm both selected images. Check the Cent window before continuing.");
  } finally {
    await rm(imageDirectory, { recursive: true, force: true });
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

export async function populateFacebookPageForm(
  profilePath: string,
  details: PageDetails,
  images: PageImages,
): Promise<"images-uploaded" | "next-clicked" | "created-clicked" | "login-required" | "checkpoint" | "category-unselected" | "create-button-unavailable" | "next-button-unavailable" | "image-upload-unavailable" | "fields-unverified" | "category-unverified" | "form-unavailable"> {
  const targetDeadline = Date.now() + TARGET_WAIT_MS;
  let target: DevToolsTarget | null = null;
  while (Date.now() < targetDeadline && !target) {
    target = await getFacebookTarget(profilePath);
    if (!target) await delay(300);
  }
  if (!target?.webSocketDebuggerUrl) {
    throw new Error("Cent did not expose its local Facebook automation endpoint.");
  }

  const socket = await connect(target.webSocketDebuggerUrl);
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
        if (!setValue(name, values.name) || !setValue(category, values.category) || !setValue(bio, values.bio)) return false;
        return readValue(name) === values.name &&
          readValue(category) === values.category &&
          readValue(bio) === values.bio;
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

      const categoryDeadline = Date.now() + 8_000;
      while (Date.now() < categoryDeadline) {
        let categoryResponse: CdpResponse;
        try {
          categoryResponse = await sendCommand(socket, ++commandId, "Runtime.evaluate", {
            expression: `(() => {
              const normalize = (value) => (value || "").normalize("NFKD").replace(/[\\u0300-\\u036f]/g, "")
                .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
              const input = document.querySelector('input[aria-label="Category (required)"]');
              if (!input) return { state: "missing" };
              input.focus();
              const requested = normalize(${JSON.stringify(details.category.trim())});
              const query = normalize(input.value || ${JSON.stringify(details.category.trim())});
              const selectedValues = () => [...document.querySelectorAll('[aria-label="Selected values"] [role="listitem"]')]
                .map((element) => element.innerText.trim());
              const existingSelection = selectedValues();
              if (existingSelection.some((value) => normalize(value).includes(requested))) {
                return { state: "selected", query, choices: [], target: existingSelection.find((value) => normalize(value).includes(requested)), selected: existingSelection };
              }
              const inputRect = input.getBoundingClientRect();
              const visibleLeaves = [...document.querySelectorAll("div, span")].filter((element) => {
                const rect = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                if (!element.children.length || [...element.children].every((child) => !child.textContent?.trim())) {
                  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" &&
                    rect.top >= inputRect.bottom - 4 && rect.top <= inputRect.bottom + 400 &&
                    rect.left + rect.width / 2 >= inputRect.left - 60 &&
                    rect.left + rect.width / 2 <= inputRect.right + 60 && element.innerText?.trim();
                }
                return false;
              }).map((element) => ({
                element,
                text: element.innerText.trim(),
                rect: element.getBoundingClientRect(),
              }));
              const matching = visibleLeaves.filter((option) => normalize(option.text).includes(query));
              const choices = matching.length ? matching : visibleLeaves;
              choices.sort((a, b) => a.rect.top - b.rect.top ||
                (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));
              const target = choices[0];
              if (!target) return { state: "waiting", query, choices: [] };
              target.element.click();
              const selected = selectedValues();
              return {
                state: selected.some((value) => normalize(value).includes(requested)) ? "selected" : "clicked",
                query,
                choices: choices.map((option) => option.text),
                target: target.text,
                selected,
              };
            })()`,
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
          if (categoryResult.state === "selected") {
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
                const fieldText = (element) => [
                  element.getAttribute("aria-label"),
                  element.getAttribute("placeholder"),
                  element.labels ? [...element.labels].map((label) => label.innerText).join(" ") : "",
                  element.closest("label")?.innerText,
                ].filter(Boolean).join(" ").trim().toLowerCase();
                const findField = (pattern) => {
                  const direct = fields.find((field) => pattern.test(fieldText(field)));
                  if (direct) return direct;
                  const label = [...document.querySelectorAll("label")].find((candidate) => visible(candidate) &&
                    [...candidate.querySelectorAll("span")].some((span) =>
                      pattern.test(span.innerText.trim().toLowerCase())));
                  return label?.control ??
                    label?.querySelector('input, textarea, [role="textbox"], [role="combobox"], [contenteditable="true"]');
                };
                const valueOf = (field) => field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
                  ? field.value.trim()
                  : field.textContent?.trim() || "";
                const name = findField(/^page\\s*name(?:\\s*\\(required\\))?$/);
                const bio = findField(/^bio(?:\\s*\\(optional\\))?$/);
                const category = [...document.querySelectorAll('[aria-label="Selected values"] [role="listitem"]')]
                  .map((element) => element.innerText.trim());
                if (!name || valueOf(name) !== expected.name || !bio || valueOf(bio) !== expected.bio) {
                  return {
                    state: "fields-unverified",
                    nameFound: Boolean(name),
                    nameMatches: Boolean(name && valueOf(name) === expected.name),
                    bioFound: Boolean(bio),
                    bioMatches: Boolean(bio && valueOf(bio) === expected.bio),
                  };
                }
                if (!category.some((value) => normalize(value).includes(normalize(expected.category)))) {
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

            await delay(2_000);

            const createResult = await clickCreatePageButton(command, details);
            if (createResult === "fields-unverified") return "fields-unverified";
            if (createResult !== "clicked") return "create-button-unavailable";

            const nextClicked = await clickNextButton(command);
            if (!nextClicked) return "next-button-unavailable";

            const imagesUploaded = await uploadPageImages(command, images);
            if (!imagesUploaded) return "image-upload-unavailable";
            return "images-uploaded";
          }
          if (categoryResult.state === "missing") break;
        }
        await delay(300);
      }
      return "category-unselected";
    }
    return "form-unavailable";
  } finally {
    socket.close();
  }
}
