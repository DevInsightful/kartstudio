import "server-only";

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

type DevToolsTarget = { id?: string; type?: string; title?: string; url?: string; webSocketDebuggerUrl?: string };
type CdpResponse = {
  id?: number;
  result?: { result?: { value?: unknown }; targetId?: string; nodeId?: number; root?: { nodeId?: number }; nodeIds?: number[]; node?: { attributes?: string[] } };
  error?: { message?: string };
};
type ReelInput = { pageName: string; videoName: string; description: string; video: Uint8Array };
type CdpCommand = (method: string, params: Record<string, unknown>) => Promise<CdpResponse>;

const WAIT_MS = 120_000;
const COMMAND_MS = 60_000;
const PAGES_URL = "https://www.facebook.com/pages/?category=your_pages";
const CREATE_REEL_URL = "https://www.facebook.com/reels/create";

function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function escapeRegex(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function connect(url: string) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, { perMessageDeflate: false });
    const timer = setTimeout(() => { socket.terminate(); reject(new Error("Cent browser did not respond to the Reel task.")); }, COMMAND_MS);
    socket.once("open", () => { clearTimeout(timer); resolve(socket); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

function command(socket: WebSocket): CdpCommand {
  let sequence = 0;
  const pending = new Map<number, { resolve: (value: CdpResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  socket.on("message", (data) => {
    let response: CdpResponse;
    try { response = JSON.parse(data.toString()) as CdpResponse; } catch { return; }
    if (typeof response.id !== "number") return;
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    clearTimeout(request.timer);
    if (response.error) request.reject(new Error(response.error.message || "Facebook browser command failed."));
    else request.resolve(response);
  });
  socket.on("close", () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("The Cent tab closed during the Reel task.")); }
    pending.clear();
  });
  return (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Facebook did not respond to ${method} within ${Math.round(COMMAND_MS / 1_000)} seconds.`)); }, COMMAND_MS);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function pageTarget(browserCommand: CdpCommand, port: number, targetId: string) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    let targets: DevToolsTarget[] = [];
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) targets = await response.json() as DevToolsTarget[];
    } catch { /* Cent may need a moment to register the tab. */ }
    const target = targets.find((candidate) => candidate.id === targetId && candidate.type === "page");
    if (target?.webSocketDebuggerUrl) {
      const page = await connect(target.webSocketDebuggerUrl);
      await pageTargetReady(page);
      return { page, pageCommand: command(page), targetId };
    }
    await delay(250);
  }
  await browserCommand("Target.closeTarget", { targetId }).catch(() => undefined);
  throw new Error("Facebook did not open the selected Page tab in Cent.");
}

async function pageTargetReady(page: WebSocket) {
  const run = command(page);
  await run("Page.enable", {});
  await run("Runtime.enable", {});
  return run;
}

async function browserConnection(profilePath: string, pageName: string) {
  const activePort = await readFile(path.join(profilePath, "DevToolsActivePort"), "utf8");
  const [portLine, browserPath] = activePort.split(/\r?\n/);
  const port = Number(portLine);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || !browserPath?.startsWith("/devtools/browser/")) {
    throw new Error("This Cent profile is not ready for Facebook Reels automation.");
  }
  const browser = await connect(`ws://127.0.0.1:${port}${browserPath}`);
  const browserCommand = command(browser);
  let targets: DevToolsTarget[] = [];
  const targetDeadline = Date.now() + 10_000;
  while (Date.now() < targetDeadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) targets = await response.json() as DevToolsTarget[];
    } catch { /* Retry while the profile's current Facebook tab registers. */ }
    if (targets.some((target) => target.type === "page" && target.url?.includes("facebook.com"))) break;
    await delay(250);
  }
  const existingFacebookTargets = targets.filter((target) => target.type === "page" && target.url && /(^|\.)facebook\.com\//i.test(target.url) && target.id && target.webSocketDebuggerUrl);
  let selectedPageTarget: { page: WebSocket; pageCommand: CdpCommand; targetId: string } | undefined;
  let ownsSelectedTarget = false;

  // Reuse the selected Page tab when it is already open in this Cent profile.
  for (const target of existingFacebookTargets) {
    let page: WebSocket | undefined;
    try {
      page = await connect(target.webSocketDebuggerUrl!);
      const run = await pageTargetReady(page);
      const currentPage = await evaluate(run, `(() => {
        const heading = document.querySelector('h1')?.innerText?.trim() || '';
        const title = document.title.replace(/\\s*[|·–-]\\s*Facebook.*$/i, '').trim();
        return { path: location.pathname, name: heading || title };
      })()`);
      if (currentPage && typeof currentPage === "object" && "name" in currentPage &&
          typeof currentPage.name === "string" && currentPage.name.localeCompare(pageName, undefined, { sensitivity: "accent" }) === 0 &&
          "path" in currentPage && typeof currentPage.path === "string" && currentPage.path !== "/" && !/^\/(pages|reels|watch|groups)\b/i.test(currentPage.path)) {
        selectedPageTarget = { page, pageCommand: run, targetId: target.id! };
        break;
      }
    } catch { /* An unrelated or still-loading Facebook tab is not the selected Page. */ }
    page?.close();
  }

  // If the Page is not open already, visit Facebook's Pages area and open the exact selected Page.
  if (!selectedPageTarget) {
    const created = await browserCommand("Target.createTarget", { url: PAGES_URL, background: false });
    const pagesTargetId = created.result?.targetId;
    if (!pagesTargetId) { browser.close(); throw new Error("Cent could not open Facebook's Pages area."); }
    let pagesTab: Awaited<ReturnType<typeof pageTarget>> | undefined;
    try {
      pagesTab = await pageTarget(browserCommand, port, pagesTargetId);
      const linkDeadline = Date.now() + WAIT_MS;
      let pageHref: string | null = null;
      while (Date.now() < linkDeadline && !pageHref) {
      const candidate = await evaluate(pagesTab.pageCommand, `(() => {
          const visible = (element) => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; };
          const wanted = ${JSON.stringify(pageName)}.trim().toLocaleLowerCase();
          const candidates = [];
          for (const anchor of document.querySelectorAll('a[href]')) {
            if (!visible(anchor)) continue;
            const ownText = (anchor.getAttribute('aria-label') || anchor.innerText || '').trim().toLocaleLowerCase();
            let container = anchor;
            let exactCard = false;
            for (let depth = 0; container && depth < 6; depth++, container = container.parentElement) {
              const lines = (container.innerText || '').split('\\n').map(line => line.trim().toLocaleLowerCase()).filter(Boolean);
              if (lines.includes(wanted)) { exactCard = true; break; }
            }
            if (!exactCard && ownText !== wanted && !ownText.includes(wanted)) continue;
            if (ownText && !ownText.includes(wanted)) continue;
            const url = new URL(anchor.href, location.href);
            if (!(url.hostname === 'facebook.com' || url.hostname.endsWith('.facebook.com'))) continue;
            if (/^\\/(|home\\.php|pages|reels|watch|groups|login|checkpoint)(\\/|$)/i.test(url.pathname)) continue;
            const slug = decodeURIComponent(url.pathname).replace(/[\\/_-]+/g, ' ').toLocaleLowerCase();
            const rank = ownText === wanted ? 0 : slug.includes(wanted.replace(/[\\s]+/g, '')) ? 1 : /profile\\.php/i.test(url.pathname) ? 2 : 3;
            candidates.push({ href: url.href, rank });
          }
          candidates.sort((a,b) => a.rank-b.rank);
          return candidates[0]?.href || null;
        })()`);
        if (typeof candidate === "string") pageHref = candidate;
        else await delay(400);
      }
      if (!pageHref) throw new Error(`Facebook's Pages area did not show the selected Page “${pageName}”; this Reel was not published.`);
      await pagesTab.pageCommand("Page.navigate", { url: pageHref });
      const pageReady = await waitFor(pagesTab.pageCommand, `(() => {
        const wanted = ${JSON.stringify(pageName)}.trim().toLocaleLowerCase();
        const heading = document.querySelector('h1')?.innerText?.trim().toLocaleLowerCase() || '';
        const title = document.title.replace(/\\s*[|·–-]\\s*Facebook.*$/i, '').trim().toLocaleLowerCase();
        const lines = (document.body?.innerText || '').split('\\n').map(line => line.trim().toLocaleLowerCase());
        const pageNameVisible = heading === wanted || title === wanted || lines.includes(wanted);
        return pageNameVisible && !/^\\/(pages|reels|watch|groups|login|checkpoint)(\\/|$)/i.test(location.pathname) && !/login|checkpoint/.test(location.pathname);
      })()`, WAIT_MS);
      if (!pageReady) throw new Error(`Facebook opened the selected Page link, but did not show “${pageName}”; this Reel was not published.`);
      selectedPageTarget = pagesTab;
      ownsSelectedTarget = true;
    } catch (error) {
      if (pagesTab) pagesTab.page.close();
      await browserCommand("Target.closeTarget", { targetId: pagesTargetId }).catch(() => undefined);
      browser.close();
      throw error;
    }
  }

  // A Page URL can be visible while Facebook is still acting as the personal profile.
  // Switch identity first and refuse to enter the composer unless Facebook confirms it.
  try {
    await ensurePageIdentity(selectedPageTarget.pageCommand, pageName);
  } catch (error) {
    selectedPageTarget.page.close();
    await browserCommand("Target.closeTarget", { targetId: selectedPageTarget.targetId }).catch(() => undefined);
    browser.close();
    throw error;
  }

  const selectedPageReady = await waitFor(selectedPageTarget.pageCommand, `(() => {
    const wanted = ${JSON.stringify(pageName.trim().toLocaleLowerCase())};
    const heading = document.querySelector('h1')?.innerText?.trim().toLocaleLowerCase() || '';
    const title = document.title.replace(/\\s*[|·–-]\\s*Facebook.*$/i, '').trim().toLocaleLowerCase();
    const lines = (document.body?.innerText || '').split('\\n').map(line => line.trim().toLocaleLowerCase());
    return (heading === wanted || title === wanted || lines.includes(wanted)) && !/login|checkpoint/.test(location.pathname);
  })()`, 15_000);
  if (!selectedPageReady) {
    selectedPageTarget.page.close();
    await browserCommand("Target.closeTarget", { targetId: selectedPageTarget.targetId }).catch(() => undefined);
    browser.close();
    throw new Error(`Facebook did not keep “${pageName}” open as the active Page. Stopped before posting.`);
  }

  await selectedPageTarget.pageCommand("Page.navigate", { url: CREATE_REEL_URL });
  const composerReady = await waitFor(selectedPageTarget.pageCommand, `location.pathname.includes('/reels/create') && !!document.body && document.body.innerText.length > 0`, 45_000);
  if (!composerReady) {
    selectedPageTarget.page.close();
    await browserCommand("Target.closeTarget", { targetId: selectedPageTarget.targetId }).catch(() => undefined);
    await browser.close();
    throw new Error(`Facebook Reels composer did not load for “${pageName}”; this Reel was not published.`);
  }
  return { browser, browserCommand, ownsSelectedTarget, ...selectedPageTarget };
}

async function evaluate(run: CdpCommand, expression: string): Promise<unknown> {
  const response = await run("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (response.result?.result && "value" in response.result.result) return response.result.result.value;
  return null;
}

async function waitFor(run: CdpCommand, expression: string, timeoutMs = WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(run, expression)) return true;
    await delay(400);
  }
  return false;
}

export async function ensurePageIdentity(run: CdpCommand, pageName: string) {
  const inspect = `(() => {
    const visible = (element) => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; };
    const controls = [...document.querySelectorAll('button,[role="button"],[role="menuitem"],a')].filter(visible)
      .map(element => (element.getAttribute('aria-label') || element.innerText || element.getAttribute('title') || '').trim()).filter(Boolean);
    const accountLabels = [...document.querySelectorAll('header [aria-label], [role="banner"] [aria-label], header img[alt], [role="banner"] img[alt]')]
      .filter(visible).map(element => (element.getAttribute('aria-label') || element.getAttribute('alt') || '').trim()).filter(Boolean);
    const body = (document.body?.innerText || '').slice(0, 5000);
    const heading = document.querySelector('h1')?.innerText?.trim() || '';
    const title = document.title.replace(/\\s*[|·–-]\\s*Facebook.*$/i, '').trim();
    const bodyLines = body.split('\\n').map(line => line.trim()).filter(Boolean);
    const pageSurface = heading.localeCompare(${JSON.stringify(pageName.trim())}, undefined, { sensitivity: 'accent' }) === 0 ||
      title.localeCompare(${JSON.stringify(pageName.trim())}, undefined, { sensitivity: 'accent' }) === 0 ||
      bodyLines.some(line => line.localeCompare(${JSON.stringify(pageName.trim())}, undefined, { sensitivity: 'accent' }) === 0);
    const switchLabel = controls.find(label => /^switch now$/i.test(label) || /^switch to (?:this )?page$/i.test(label) || new RegExp('^switch to\\s+' + ${JSON.stringify(escapeRegex(pageName))} + '$', 'i').test(label));
    const explicitIdentity = accountLabels.some(label => label.toLocaleLowerCase().includes(${JSON.stringify(pageName.trim().toLocaleLowerCase())})) ||
      new RegExp('(?:now (?:using|acting as|interacting as)|switched to)\\s+' + ${JSON.stringify(escapeRegex(pageName))}, 'i').test(body);
    return { active: explicitIdentity || (pageSurface && !switchLabel), switchLabel, heading, title, path: location.pathname };
  })()`;
  const initial = await evaluate(run, inspect);
  if (!initial || typeof initial !== "object") throw new Error(`Facebook could not verify the selected Page “${pageName}”.`);
  if ("active" in initial && initial.active === true) return;
  const switchLabel = "switchLabel" in initial && typeof initial.switchLabel === "string" ? initial.switchLabel : "";
  if (!switchLabel || !await clickLabel(run, `^${escapeRegex(switchLabel)}$`, 8_000)) {
    throw new Error(`Facebook opened “${pageName}” but did not expose a confirmed switch-to-Page control. Stopped before posting.`);
  }
  const switched = await waitFor(run, `(${inspect}).active === true`, 15_000);
  if (!switched) {
    const state = await evaluate(run, inspect);
    const detail = state && typeof state === "object"
      ? ` Facebook showed heading “${"heading" in state && typeof state.heading === "string" ? state.heading : ""}”, title “${"title" in state && typeof state.title === "string" ? state.title : ""}”, at ${"path" in state && typeof state.path === "string" ? state.path : "an unknown URL"}.`
      : "";
    throw new Error(`Facebook did not confirm that the profile switched to “${pageName}”.${detail} Stopped before posting.`);
  }
}

async function visibleButtons(run: CdpCommand) {
  const value = await evaluate(run, `(() => {
    const visible = (element) => {
    const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const dialogs = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].filter(visible);
    const caption = [...document.querySelectorAll('textarea,[role="textbox"],[contenteditable="true"],[contenteditable="plaintext-only"]')]
      .find(field => visible(field) && /describe your reel|caption/i.test([field.getAttribute('aria-label'),field.getAttribute('placeholder'),field.getAttribute('data-placeholder')].filter(Boolean).join(' ')));
    const scope = dialogs.find(dialog => caption && dialog.contains(caption)) || dialogs[dialogs.length - 1] || document;
    return [...scope.querySelectorAll('button,[role="button"],a')].filter(visible)
      .map((element) => ({label:(element.getAttribute('aria-label') || element.innerText || '').trim(),disabled:element.getAttribute('aria-disabled') === 'true' || element.disabled === true}));
  })()`);
  return Array.isArray(value) ? value.filter((item): item is { label: string; disabled: boolean } => !!item && typeof item === "object" && "label" in item && typeof item.label === "string" && "disabled" in item && typeof item.disabled === "boolean") : [];
}

async function clickLabel(run: CdpCommand, pattern: string, timeoutMs = WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const clicked = await evaluate(run, `(() => {
      const pattern = new RegExp(${JSON.stringify(pattern)}, 'i');
      const visible = (element) => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; };
      const dialogs = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].filter(visible);
      const caption = [...document.querySelectorAll('textarea,[role="textbox"],[contenteditable="true"],[contenteditable="plaintext-only"]')]
        .find(field => visible(field) && /describe your reel|caption/i.test([field.getAttribute('aria-label'),field.getAttribute('placeholder'),field.getAttribute('data-placeholder')].filter(Boolean).join(' ')));
      const scope = dialogs.find(dialog => caption && dialog.contains(caption)) || dialogs[dialogs.length - 1] || document;
      const elements = [...scope.querySelectorAll('button,[role="button"],a')].filter(visible);
      const element = elements.find((item) => pattern.test((item.getAttribute('aria-label') || item.innerText || '').trim()) && item.getAttribute('aria-disabled') !== 'true' && !item.disabled);
      if (!element) return false; element.click(); return true;
    })()`);
    if (clicked === true) return true;
    await delay(350);
  }
  return false;
}

async function uploadVideo(run: CdpCommand, videoPath: string) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const document = await run("DOM.getDocument", { depth: -1, pierce: true });
    const root = document.result?.root?.nodeId;
    if (root) {
      const inputs = await run("DOM.querySelectorAll", { nodeId: root, selector: 'input[type="file"]' });
      const nodeIds = inputs.result?.nodeIds ?? [];
      for (const nodeId of nodeIds) {
        const info = await run("DOM.describeNode", { nodeId });
        const attributes = info.result?.node?.attributes ?? [];
        const acceptIndex = attributes.findIndex((attribute) => attribute.toLowerCase() === "accept");
        const accept = acceptIndex >= 0 ? attributes[acceptIndex + 1] ?? "" : "";
        if (!accept || /video|mp4|mov|quicktime|webm/i.test(accept)) {
          await run("DOM.setFileInputFiles", { nodeId, files: [videoPath] });
          return;
        }
      }
    }
    await delay(400);
  }
  throw new Error("Facebook's video upload control did not appear; this Reel was not published.");
}

export async function waitForVideoUpload(run: CdpCommand) {
  const ready = await waitFor(run, `(() => {
    const visible = element => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; };
    const dialogs = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].filter(visible);
    const scope = dialogs[dialogs.length - 1] || document;
    const next = [...scope.querySelectorAll('button,[role="button"],a')].find(button => visible(button) && /^next$/i.test((button.getAttribute('aria-label') || button.innerText || '').trim()));
    const uploadInProgress = [...document.querySelectorAll('[role="progressbar"],[aria-busy="true"]')].some(visible) ||
      /uploading|processing video|preparing video/i.test(document.body?.innerText || '');
    const videoReady = [...document.querySelectorAll('video,[data-pagelet*="Video"],[aria-label*="video" i]')].some(visible);
    return videoReady && !!next && next.getAttribute('aria-disabled') !== 'true' && next.disabled !== true && !uploadInProgress;
  })()`, WAIT_MS);
  if (!ready) throw new Error("Facebook did not finish preparing the uploaded Reel or enable Next. The workflow stopped before publishing.");
}

export async function typeDescription(run: CdpCommand, description: string) {
  const expression = `(() => {
    const visible = (element) => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'; };
    const candidates = [...document.querySelectorAll('textarea,[role="textbox"],[contenteditable="true"],[contenteditable="plaintext-only"]')]
      .filter(element => visible(element) && element.getBoundingClientRect().width >= 160 && element.getBoundingClientRect().height >= 28);
    const dialogs = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].filter(visible);
    const inDialog = candidates.filter(element => dialogs.some(dialog => dialog.contains(element)));
    const pool = inDialog.length ? inDialog : candidates;
    const label = element => [element.getAttribute('aria-label'),element.getAttribute('placeholder'),element.getAttribute('data-placeholder'),element.innerText].filter(Boolean).join(' ');
    const hinted = pool.find(element => /describe|caption|description|write something|say something/i.test(label(element)));
    const ranked = [...pool].sort((a,b) => {
      const ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
      return (rb.width*rb.height)-(ra.width*ra.height);
    });
    const field = hinted || ranked[0];
    if (!field) return null;
    const rect = field.getBoundingClientRect();
    return {x:rect.left+rect.width/2,y:rect.top+rect.height/2,tag:field.tagName,label:label(field)};
  })()`;
  const deadline = Date.now() + 60_000;
  let position: unknown = null;
  while (Date.now() < deadline) {
    position = await evaluate(run, expression);
    if (position && typeof position === "object" && "x" in position && typeof position.x === "number" && "y" in position && typeof position.y === "number") break;
    await delay(400);
  }
  if (!position || typeof position !== "object" || !("x" in position) || typeof position.x !== "number" || !("y" in position) || typeof position.y !== "number") {
    const screen = await evaluate(run, `(() => ({path:location.pathname,title:document.title,heading:document.querySelector('[role="dialog"] h1,[role="dialog"] h2,h1,h2')?.innerText?.trim()||''}))()`);
    const detail = screen && typeof screen === "object" ? ` Current screen: ${"heading" in screen && typeof screen.heading === "string" ? screen.heading : "no heading"} (${"path" in screen && typeof screen.path === "string" ? screen.path : "unknown path"}).` : "";
    throw new Error(`Facebook's Reel caption editor did not appear.${detail} This Reel was not published.`);
  }
  await run("Input.dispatchMouseEvent", { type: "mousePressed", x: position.x, y: position.y, button: "left", clickCount: 1 });
  await run("Input.dispatchMouseEvent", { type: "mouseReleased", x: position.x, y: position.y, button: "left", clickCount: 1 });
  await run("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
  await run("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
  await run("Input.insertText", { text: description });
  const verified = await evaluate(run, `(() => [...document.querySelectorAll('textarea,[role="textbox"],[contenteditable="true"]')].some((element) => (element.value || element.innerText || '').trim() === ${JSON.stringify(description)}))()`);
  if (verified !== true) throw new Error("Facebook did not confirm the Reel description; this Reel was not published.");
}

export async function publishFacebookReel(profilePath: string, input: ReelInput): Promise<void> {
  const session = await browserConnection(profilePath, input.pageName);
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "kartstudio-reel-"));
  const extension = path.extname(input.videoName).toLowerCase();
  const videoPath = path.join(temporaryDirectory, `reel${extension || ".mp4"}`);
  let publishConfirmed = false;
  try {
    await session.pageCommand("Page.enable", {});
    await session.pageCommand("Runtime.enable", {});
    await session.pageCommand("DOM.enable", {});
    await writeFile(videoPath, input.video, { flag: "wx" });
    // browserConnection opens and confirms this Page identity before navigating to the composer.
    // Keep that Page context; Facebook's Reel composer does not consistently expose a second Page selector.
    const addVideo = await visibleButtons(session.pageCommand);
    if (addVideo.some((item) => /add video|select video|upload video/i.test(item.label))) {
      // The file input is often already mounted while Facebook animates the picker open.
      // Keep polling for that input if the visible card does not accept a scripted click.
      await clickLabel(session.pageCommand, "add video|select video|upload video", 8_000);
    }
    await uploadVideo(session.pageCommand, videoPath);
    await waitForVideoUpload(session.pageCommand);
    // Facebook first shows an edit/preview screen after upload. The caption
    // editor appears only after advancing to the next screen.
    if (!await clickLabel(session.pageCommand, "^next$", 15_000)) {
      throw new Error("Facebook enabled the uploaded Reel but did not advance to its details screen. The Reel was not published.");
    }
    await typeDescription(session.pageCommand, input.description);

    const buttons = await visibleButtons(session.pageCommand);
    if (buttons.some((item) => /^next$/i.test(item.label)) && !await clickLabel(session.pageCommand, "^next$", 8_000)) {
      throw new Error("Facebook's final Reel details step could not be opened.");
    }
    if (!await clickLabel(session.pageCommand, "^publish$|^share$", WAIT_MS)) throw new Error("Facebook did not show an enabled Publish or Share button.");

    const published = await waitFor(session.pageCommand, `(() => { const text=(document.body?.innerText || '').toLowerCase(); const success=/reel (was )?published|your reel is published|shared your reel|published successfully/.test(text); const blocked=/checkpoint|log in to facebook|something went wrong|couldn't publish|could not publish/.test(text); return success || (!location.pathname.includes('/reels/create') && !blocked && !/login|checkpoint/.test(location.pathname)); })()`, 120_000);
    if (!published) throw new Error("Facebook accepted the publish click but did not confirm completion; check this Page before retrying.");
    publishConfirmed = true;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    session.page.close();
    // Keep the Facebook tab open after errors so the user can inspect the exact stage.
    // Reused profile tabs belong to the user and must never be closed by this workflow.
    if (publishConfirmed && session.ownsSelectedTarget) {
      await session.browserCommand("Target.closeTarget", { targetId: session.targetId }).catch(() => undefined);
    }
    session.browser.close();
  }
}
