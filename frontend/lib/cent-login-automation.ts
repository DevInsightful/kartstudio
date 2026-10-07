import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";

type Credentials = { username: string; password: string };
type DevToolsTarget = { type?: string; url?: string; webSocketDebuggerUrl?: string };
type CdpResponse = {
  id?: number;
  result?: { result?: { value?: unknown }; exceptionDetails?: unknown };
  error?: { message?: string };
};

const DEBUG_PORT_FILE = "DevToolsActivePort";
const TARGET_WAIT_MS = 30_000;
const COMMAND_WAIT_MS = 10_000;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export async function submitFacebookLogin(profilePath: string, credentials: Credentials): Promise<void> {
  const deadline = Date.now() + TARGET_WAIT_MS;
  let target: DevToolsTarget | null = null;
  while (Date.now() < deadline && !target) {
    target = await getFacebookTarget(profilePath);
    if (!target) await delay(300);
  }
  if (!target?.webSocketDebuggerUrl) {
    throw new Error("Cent did not expose its local automation endpoint.");
  }

  const socket = await connect(target.webSocketDebuggerUrl);
  try {
    const credentialLiteral = JSON.stringify(credentials);
    let commandId = 0;
    let coordinates: { x: number; y: number } | null = null;
    while (Date.now() < deadline && !coordinates) {
      const expression = `(() => {
        const email = document.querySelector('input[name="email"], #email');
        const password = document.querySelector('input[name="pass"], #pass');
        const submit = email && password && (email.form?.querySelector('button[name="login"], input[name="login"], button[type="submit"], input[type="submit"]'));
        if (!(email instanceof HTMLInputElement) || !(password instanceof HTMLInputElement) || !(submit instanceof HTMLElement)) return null;
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (!setValue) return null;
        const values = ${credentialLiteral};
        setValue.call(email, values.username);
        email.dispatchEvent(new Event("input", { bubbles: true }));
        email.dispatchEvent(new Event("change", { bubbles: true }));
        setValue.call(password, values.password);
        password.dispatchEvent(new Event("input", { bubbles: true }));
        password.dispatchEvent(new Event("change", { bubbles: true }));
        submit.scrollIntoView({ block: "center" });
        const rect = submit.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
      })()`;
      const response = await sendCommand(socket, ++commandId, "Runtime.evaluate", { expression, returnByValue: true });
      if (response.result?.exceptionDetails) throw new Error("Facebook's login form could not be prepared.");
      const value = response.result?.result?.value;
      if (value && typeof value === "object" && "x" in value && "y" in value &&
          typeof value.x === "number" && typeof value.y === "number") {
        coordinates = { x: value.x, y: value.y };
      } else {
        await delay(300);
      }
    }
    if (!coordinates) throw new Error("Facebook's login form was not available.");

    await sendCommand(socket, ++commandId, "Input.dispatchMouseEvent", {
      type: "mousePressed", x: coordinates.x, y: coordinates.y, button: "left", clickCount: 1,
    });
    await sendCommand(socket, ++commandId, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x: coordinates.x, y: coordinates.y, button: "left", clickCount: 1,
    });
  } finally {
    socket.close();
  }
}
