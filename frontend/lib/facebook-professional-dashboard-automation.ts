import "server-only";

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { ensurePageIdentity, typeDescription, waitForVideoUpload } from "@/lib/facebook-reels-automation";

type Target = { id?: string; type?: string; url?: string; webSocketDebuggerUrl?: string };
type Response = {
  id?: number;
  result?: { result?: { value?: unknown }; targetId?: string; root?: { nodeId?: number }; nodeIds?: number[]; node?: { attributes?: string[] } };
  error?: { message?: string };
};
type Command = (method: string, params: Record<string, unknown>) => Promise<Response>;
type UploadFile = { name: string; data: Uint8Array };

const CONTENT_LIBRARY_URL = "https://www.facebook.com/professional_dashboard/content/content_library/";
const PAGES_URL = "https://www.facebook.com/pages/?category=your_pages";
const TIMEOUT_MS = 120_000;
const UPLOAD_WAIT_MS = 30 * 60_000;
const COMMAND_TIMEOUT_MS = 30_000;

function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function connect(url: string) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, { perMessageDeflate: false });
    const timer = setTimeout(() => { socket.terminate(); reject(new Error("Cent did not respond to the Professional Dashboard upload.")); }, COMMAND_TIMEOUT_MS);
    socket.once("open", () => { clearTimeout(timer); resolve(socket); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

function command(socket: WebSocket): Command {
  let sequence = 0;
  const pending = new Map<number, { resolve: (value: Response) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  socket.on("message", (data) => {
    let response: Response;
    try { response = JSON.parse(data.toString()) as Response; } catch { return; }
    if (typeof response.id !== "number") return;
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    clearTimeout(request.timer);
    if (response.error) request.reject(new Error(response.error.message || "Facebook browser command failed."));
    else request.resolve(response);
  });
  socket.on("close", () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("The Cent tab closed during the upload.")); }
    pending.clear();
  });
  return (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Facebook did not respond to ${method}.`)); }, COMMAND_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(run: Command, expression: string): Promise<unknown> {
  const response = await run("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (response.result?.result && "value" in response.result.result) return response.result.result.value;
  return null;
}

async function waitFor(run: Command, expression: string, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(run, expression)) return true;
    await delay(400);
  }
  return false;
}

async function getTarget(port: number, targetId: string) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        const targets = await response.json() as Target[];
        const target = targets.find((item) => item.id === targetId && item.type === "page" && item.webSocketDebuggerUrl);
        if (target?.webSocketDebuggerUrl) return target.webSocketDebuggerUrl;
      }
    } catch { /* Wait for Cent to register the new tab. */ }
    await delay(250);
  }
  throw new Error("Cent did not open the Professional Dashboard tab.");
}

async function connectPage(port: number, targetId: string) {
  const socket = await connect(await getTarget(port, targetId));
  const run = command(socket);
  await run("Page.enable", {});
  await run("Runtime.enable", {});
  await run("DOM.enable", {});
  return { socket, run, targetId };
}

async function openSelectedPage(port: number, browserCommand: Command, pageName: string) {
  let targets: Target[] = [];
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) });
    if (response.ok) targets = await response.json() as Target[];
  } catch { /* Cent can still open a new Pages tab below. */ }
  const wanted = pageName.trim();
  for (const target of targets.filter((item) => item.type === "page" && item.id && item.url && /(^|\.)facebook\.com\//i.test(item.url) && item.webSocketDebuggerUrl)) {
    let tab: Awaited<ReturnType<typeof connectPage>> | undefined;
    try {
      tab = await connectPage(port, target.id!);
      const isSelected = await evaluate(tab.run, `(() => {
        const wanted = ${JSON.stringify(wanted)};
        const heading = document.querySelector('h1')?.innerText?.trim() || '';
        const title = document.title.replace(/\\s*[|·–-]\\s*Facebook.*$/i, '').trim();
        const pageSurface = !/^\\/(|pages|reels|watch|groups|login|checkpoint)(\\/|$)/i.test(location.pathname);
        return pageSurface && [heading, title].some(value => value.localeCompare(wanted, undefined, { sensitivity: 'accent' }) === 0);
      })()`);
      if (isSelected === true) {
        await ensurePageIdentity(tab.run, pageName);
        return tab;
      }
    } catch (error) {
      tab?.socket.close();
      if (error instanceof Error && error.message.includes("did not confirm that the profile switched")) throw error;
    }
    tab?.socket.close();
  }

  const created = await browserCommand("Target.createTarget", { url: PAGES_URL, background: false });
  const pagesTargetId = created.result?.targetId;
  if (!pagesTargetId) throw new Error("Cent could not open Facebook's Pages area to switch to the selected Page.");
  const tab = await connectPage(port, pagesTargetId);
  const loaded = await waitFor(tab.run, `!!document.body && document.body.innerText.length > 0 && !/login|checkpoint/i.test(location.pathname)`, 60_000);
  if (!loaded) { tab.socket.close(); throw new Error("Facebook's Pages area did not load in this Cent profile."); }
  const pageHref = await waitForValue(tab.run, `(() => {
    const visible = element => { const rect=element.getBoundingClientRect(); const style=getComputedStyle(element); return rect.width>0 && rect.height>0 && style.display!=='none' && style.visibility!=='hidden'; };
    const wanted = ${JSON.stringify(wanted)}.trim().toLocaleLowerCase();
    const candidates = [];
    for (const anchor of document.querySelectorAll('a[href]')) {
      if (!visible(anchor)) continue;
      const ownText = (anchor.getAttribute('aria-label') || anchor.innerText || '').trim().toLocaleLowerCase();
      let container = anchor;
      let exactCard = false;
      for (let depth=0; container && depth<6; depth++, container=container.parentElement) {
        if ((container.innerText || '').split('\\n').map(line=>line.trim().toLocaleLowerCase()).includes(wanted)) { exactCard=true; break; }
      }
      if (!exactCard && ownText !== wanted && !ownText.includes(wanted)) continue;
      if (ownText && !ownText.includes(wanted)) continue;
      const url = new URL(anchor.href, location.href);
      if (!(url.hostname==='facebook.com' || url.hostname.endsWith('.facebook.com'))) continue;
      if (/^\\/(|home\\.php|pages|reels|watch|groups|login|checkpoint)(\\/|$)/i.test(url.pathname)) continue;
      candidates.push({ href:url.href, rank:ownText===wanted ? 0 : /profile\\.php/i.test(url.pathname) ? 2 : 1 });
    }
    candidates.sort((a,b)=>a.rank-b.rank);
    return candidates[0]?.href || null;
  })()`, 60_000);
  if (typeof pageHref !== "string") { tab.socket.close(); throw new Error(`Facebook's Pages area did not show “${pageName}” in this account. No upload was started.`); }
  await tab.run("Page.navigate", { url: pageHref });
  const selected = await waitFor(tab.run, `(() => {
    const wanted=${JSON.stringify(wanted)}.trim();
    const heading=document.querySelector('h1')?.innerText?.trim() || '';
    const title=document.title.replace(/\\s*[|·–-]\\s*Facebook.*$/i,'').trim();
    const lines=(document.body?.innerText || '').split('\\n').map(line=>line.trim());
    return [heading,title,...lines].some(value=>value.localeCompare(wanted,undefined,{sensitivity:'accent'})===0) && !/login|checkpoint/i.test(location.pathname);
  })()`, 60_000);
  if (!selected) { tab.socket.close(); throw new Error(`Facebook opened a link but did not confirm the selected Page “${pageName}”. No upload was started.`); }
  await ensurePageIdentity(tab.run, pageName);
  return tab;
}

async function waitForValue(run: Command, expression: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(run, expression);
    if (value) return value;
    await delay(400);
  }
  return null;
}

async function clickLabel(run: Command, pattern: string, timeoutMs = 20_000, preferTopDialog = false) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const clicked = await evaluate(run, `(() => {
      const pattern = new RegExp(${JSON.stringify(pattern)}, 'i');
      const preferTopDialog = ${JSON.stringify(preferTopDialog)};
      const visible = element => { const rect=element.getBoundingClientRect(); const style=getComputedStyle(element); return rect.width>0 && rect.height>0 && style.display!=='none' && style.visibility!=='hidden'; };
      const dialogs = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].filter(visible);
      const scope = preferTopDialog ? dialogs[dialogs.length - 1] || document : document;
      const elements = [...scope.querySelectorAll('button,[role="button"],[role="menuitem"],a,label')].filter(visible);
      const button = elements.find(element => pattern.test((element.getAttribute('aria-label') || element.innerText || element.getAttribute('title') || '').trim()) && element.getAttribute('aria-disabled') !== 'true' && element.disabled !== true);
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (clicked === true) return true;
    await delay(350);
  }
  return false;
}

type StoredUploadFile = UploadFile & { dataPath: string };

async function setVideos(run: Command, files: StoredUploadFile[], mode: "reel" | "bulk") {
  if (mode === "bulk" && !await clickLabel(run, "^upload from your computer$", 15_000, true)) {
    throw new Error("Facebook's Bulk upload reels dialog did not show Upload from your computer. No video was attached to the Reel composer behind it.");
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const metadata = await evaluate(run, `(() => [...document.querySelectorAll('input[type="file"]')].map(input => {
      let node=input, context='';
      for (let depth=0; node && depth<10; depth++, node=node.parentElement) {
        const text=(node.innerText || '').trim();
        if (text.length > context.length && text.length < 6000) context=text;
        if (/bulk upload reels/i.test(text) && /upload from your computer/i.test(text)) break;
      }
      const rect=input.getBoundingClientRect(), style=getComputedStyle(input);
      return { accept:input.getAttribute('accept') || '', multiple:input.hasAttribute('multiple'), visible:rect.width>0 && rect.height>0 && style.display!=='none' && style.visibility!=='hidden', bulkContext:/bulk upload reels/i.test(context) && /upload from your computer/i.test(context) };
    }))()`);
    const document = await run("DOM.getDocument", { depth: -1, pierce: true });
    const rootId = document.result?.root?.nodeId;
    if (rootId) {
      const result = await run("DOM.querySelectorAll", { nodeId: rootId, selector: 'input[type="file"]' });
      const nodeIds = result.result?.nodeIds ?? [];
      const candidates = Array.isArray(metadata) ? metadata.map((entry, index) => ({ entry: entry as { accept?: string; multiple?: boolean; visible?: boolean; bulkContext?: boolean }, nodeId: nodeIds[index] })).filter((item) => item.nodeId !== undefined) : [];
      if (mode === "bulk" && !candidates.some((item) => item.entry.bulkContext)) {
        throw new Error("Facebook did not expose the bulk dialog's own video input. Stopped to avoid attaching files to the Reel composer behind it.");
      }
      candidates.sort((left, right) => {
        const rank = (entry: typeof left.entry) => (mode === "bulk"
          ? (entry.bulkContext ? 8 : 0) + (entry.multiple ? 4 : 0) + (/video|mp4|mov|quicktime|webm/i.test(entry.accept ?? "") ? 2 : 0) + (entry.visible ? 1 : 0)
          : (!entry.multiple ? 4 : 0) + (/video|mp4|mov|quicktime|webm/i.test(entry.accept ?? "") ? 2 : 0) + (entry.visible ? 1 : 0));
        return rank(right.entry) - rank(left.entry);
      });
      for (const { entry, nodeId } of candidates) {
        const accept = entry.accept ?? "";
        if (mode === "bulk" && !entry.multiple) continue;
        if (mode === "bulk" && candidates.some((item) => item.entry.bulkContext) && !entry.bulkContext) continue;
        if (/image/i.test(accept) && !/video/i.test(accept)) continue;
        const described = await run("DOM.describeNode", { nodeId });
        if (!described.result?.node) continue;
        await run("DOM.setFileInputFiles", { nodeId, files: files.map((file) => file.dataPath) });
        return;
      }
    }
    await delay(400);
  }
  throw new Error("Facebook did not open a video file picker. The Content Library remains open for review.");
}

async function setBulkDescriptions(run: Command, expectedVideos: number, description: string) {
  if (!description.trim()) return;
  const selector = `(() => {
    const visible = element => { const rect=element.getBoundingClientRect(), style=getComputedStyle(element); return rect.width>0 && rect.height>0 && style.display!=='none' && style.visibility!=='hidden'; };
    return [...document.querySelectorAll('[contenteditable="true"][role="textbox"]')].filter(element => visible(element) && element.getAttribute('aria-placeholder') === "What's on your mind?");
  })()`;
  const deadline = Date.now() + 30_000;
  let count = 0;
  while (Date.now() < deadline) {
    count = await evaluate(run, `(${selector}).length`) as number;
    if (count === expectedVideos) break;
    await delay(400);
  }
  if (count !== expectedVideos) throw new Error(`Facebook showed ${count} description fields for ${expectedVideos} uploaded videos. The upload remains open so no videos are saved without the shared description.`);

  for (let index = 0; index < expectedVideos; index++) {
    const position = await evaluate(run, `(() => {
      const visible = element => { const rect=element.getBoundingClientRect(), style=getComputedStyle(element); return rect.width>0 && rect.height>0 && style.display!=='none' && style.visibility!=='hidden'; };
      const fields=[...document.querySelectorAll('[contenteditable="true"][role="textbox"]')].filter(element => visible(element) && element.getAttribute('aria-placeholder') === "What's on your mind?");
      const field=fields[${index}];
      if (!field) return null;
      field.scrollIntoView({ block:'center', inline:'nearest' });
      const rect=field.getBoundingClientRect();
      return { x:rect.left+rect.width/2, y:rect.top+rect.height/2 };
    })()`);
    if (!position || typeof position !== "object" || !("x" in position) || typeof position.x !== "number" || !("y" in position) || typeof position.y !== "number") {
      throw new Error(`Facebook's description field for video ${index + 1} disappeared. The upload remains open for review.`);
    }
    await run("Input.dispatchMouseEvent", { type: "mousePressed", x: position.x, y: position.y, button: "left", clickCount: 1 });
    await run("Input.dispatchMouseEvent", { type: "mouseReleased", x: position.x, y: position.y, button: "left", clickCount: 1 });
    await run("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
    await run("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
    await run("Input.insertText", { text: description });
    const verified = await evaluate(run, `(() => {
      const visible = element => { const rect=element.getBoundingClientRect(), style=getComputedStyle(element); return rect.width>0 && rect.height>0 && style.display!=='none' && style.visibility!=='hidden'; };
      const fields=[...document.querySelectorAll('[contenteditable="true"][role="textbox"]')].filter(element => visible(element) && element.getAttribute('aria-placeholder') === "What's on your mind?");
      return fields[${index}]?.innerText?.trim() === ${JSON.stringify(description.trim())};
    })()`);
    if (verified !== true) throw new Error(`Facebook did not confirm the shared description for video ${index + 1}. The upload remains open for review.`);
  }
}

async function waitForBulkUploadAndSave(run: Command, expectedVideos: number, description = "") {
  const ready = await waitFor(run, `(() => {
    const visible = element => { const rect=element.getBoundingClientRect(); const style=getComputedStyle(element); return rect.width>0 && rect.height>0 && style.display!=='none' && style.visibility!=='hidden'; };
    const body = document.body?.innerText || '';
    const count = body.match(/Uploaded\\s+(\\d+)\\s*\\/\\s*(\\d+)\\s+videos/i);
    const save = [...document.querySelectorAll('button,[role="button"]')].find(element => visible(element) && /^save$/i.test((element.getAttribute('aria-label') || element.innerText || '').trim()));
    return !!count && Number(count[1]) === ${expectedVideos} && Number(count[2]) === ${expectedVideos} && !!save && save.getAttribute('aria-disabled') !== 'true' && save.disabled !== true;
  })()`, UPLOAD_WAIT_MS);
  if (!ready) throw new Error(`Facebook did not confirm all ${expectedVideos} videos uploaded with Save enabled. The bulk upload window is left open for review.`);

  await setBulkDescriptions(run, expectedVideos, description);

  const beforeUrl = await evaluate(run, "location.href");
  if (!await clickLabel(run, "^save$", 15_000, true)) throw new Error("All videos uploaded, but Facebook's enabled Save button could not be clicked. The window is left open.");
  const saved = await waitFor(run, `(() => {
    const body=(document.body?.innerText || '').toLowerCase();
    const save=[...document.querySelectorAll('button,[role="button"]')].some(element => {
      const rect=element.getBoundingClientRect(), style=getComputedStyle(element);
      return rect.width>0 && rect.height>0 && style.display!=='none' && style.visibility!=='hidden' && /^save$/i.test((element.getAttribute('aria-label') || element.innerText || '').trim());
    });
    const success=/saved successfully|reels? (?:were )?(?:saved|published)|upload complete|changes saved/i.test(body);
    return success || (!save && location.href !== ${JSON.stringify(beforeUrl)});
  })()`, 90_000);
  if (!saved) throw new Error("Facebook received the Save click but did not confirm completion. Check the open bulk-upload window before retrying.");
}

export async function uploadViaProfessionalDashboard(
  profilePath: string,
  pageName: string,
  mode: "reel" | "bulk",
  inputFiles: UploadFile[],
  description = "",
): Promise<string> {
  const activePort = await readFile(path.join(profilePath, "DevToolsActivePort"), "utf8");
  const [portLine, browserPath] = activePort.split(/\r?\n/);
  const port = Number(portLine);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || !browserPath?.startsWith("/devtools/browser/")) {
    throw new Error("Cent did not expose its local automation endpoint. Reopen this account profile and retry.");
  }

  const browser = await connect(`ws://127.0.0.1:${port}${browserPath}`);
  const browserCommand = command(browser);
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "kartstudio-dashboard-upload-"));
  let pageSocket: WebSocket | undefined;
  try {
    const files: StoredUploadFile[] = [];
    for (const file of inputFiles) {
      const filePath = path.join(temporaryDirectory, path.basename(file.name));
      await writeFile(filePath, file.data, { flag: "wx" });
      files.push({ ...file, dataPath: filePath });
    }

    const selectedPage = await openSelectedPage(port, browserCommand, pageName);
    pageSocket = selectedPage.socket;
    const pageCommand = selectedPage.run;
    await pageCommand("Page.navigate", { url: CONTENT_LIBRARY_URL });
    const loaded = await waitFor(pageCommand, `location.href.includes('/professional_dashboard/content/content_library') && !!document.body && document.body.innerText.length > 0`, 60_000);
    if (!loaded) throw new Error("Facebook's Professional Dashboard Content Library did not load. The Cent tab is left open.");
    const loginRequired = await evaluate(pageCommand, `/(?:\/login|\/checkpoint)/i.test(location.pathname)`);
    if (loginRequired === true) throw new Error("Facebook needs you to sign in or complete a security check. The Cent tab is left open.");

    if (!await clickLabel(pageCommand, "^\\+?\\s*create$", 30_000)) {
      throw new Error("Facebook's Content Library did not show the Create menu. The Cent tab is left open.");
    }
    const option = mode === "reel" ? "^reel$" : "^bulk upload reels$";
    if (!await clickLabel(pageCommand, option, 20_000)) {
      throw new Error(`Facebook did not offer the ${mode === "reel" ? "Reel" : "Bulk upload reels"} option. The Cent tab is left open.`);
    }

    if (mode === "reel") {
      const composerReady = await waitFor(pageCommand, `location.pathname.includes('/reels/create') && !!document.body && document.body.innerText.length > 0`, 45_000);
      if (!composerReady) throw new Error("Facebook did not open the single-Reel composer. The Content Library tab is left open.");
      await setVideos(pageCommand, files, "reel");
      await waitForVideoUpload(pageCommand);
      if (!await clickLabel(pageCommand, "^next$", 15_000)) {
        throw new Error("Facebook uploaded the Reel but did not advance from the edit screen. The Reel was not published.");
      }
      if (description.trim()) {
        await typeDescription(pageCommand, description.trim());
        // Advance to the final composer screen when Facebook exposes a second Next.
        await clickLabel(pageCommand, "^next$", 5_000);
      }
      return `Facebook opened the single-Reel composer for “${pageName}” and loaded ${files[0].name}${description.trim() ? " with its description" : ""}. The Cent tab is left at Facebook for final review; Publish/Share was not clicked.`;
    }

    await setVideos(pageCommand, files, "bulk");
    await waitForBulkUploadAndSave(pageCommand, files.length, description);
    return `Facebook uploaded all ${files.length} videos and confirmed Save. The bulk upload was saved for “${pageName}”.`;
  } finally {
    pageSocket?.close();
    browser.close();
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}
