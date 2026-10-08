import "server-only";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
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
    root?: { nodeId?: number };
    exceptionDetails?: unknown;
  };
  error?: { message?: string };
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
    socket.send(JSON.stringify({ id, method, params }), (error) => {
      if (error) finish(error);
    });
  });
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
