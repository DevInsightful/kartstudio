"use server";

import "server-only";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { getLocalWorkspace, prisma } from "@/lib/prisma";
import { populateAndSubmitFacebookLogin } from "@/lib/cent-login-automation";

const MAX_BATCH_SIZE = 20;
const FACEBOOK_LOGIN_URL = "https://www.facebook.com/login/";
const PROFILE_ROOT = path.join(process.cwd(), "data", "browser-profiles");
const execFileAsync = promisify(execFile);
type LaunchResult = {
  openedIds: number[];
  failed: string[];
  manualLoginIds: number[];
  populationErrors: string[];
};
type LaunchOutcome = { error?: string };
type WindowBounds = { x: number; y: number; width: number; height: number };
type WorkArea = WindowBounds;

async function getPrimaryWorkArea(): Promise<WorkArea> {
  const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; $b=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; [PSCustomObject]@{x=$b.X;y=$b.Y;width=$b.Width;height=$b.Height} | ConvertTo-Json -Compress";
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", script,
  ], { windowsHide: true, timeout: 10_000, encoding: "utf8" });
  const value: unknown = JSON.parse(stdout.trim());
  if (!value || typeof value !== "object" || !("x" in value) || !("y" in value) ||
      !("width" in value) || !("height" in value) ||
      ![value.x, value.y, value.width, value.height].every(Number.isSafeInteger) ||
      Number(value.width) < 320 || Number(value.height) < 240) {
    throw new Error("Could not determine a usable Windows display area for the Cent profiles.");
  }
  return { x: Number(value.x), y: Number(value.y), width: Number(value.width), height: Number(value.height) };
}

function tileBounds(workArea: WorkArea, index: number, count: number): WindowBounds {
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const column = index % columns;
  const row = Math.floor(index / columns);
  const left = Math.floor(column * workArea.width / columns);
  const top = Math.floor(row * workArea.height / rows);
  const right = Math.floor((column + 1) * workArea.width / columns);
  const bottom = Math.floor((row + 1) * workArea.height / rows);
  return {
    x: workArea.x + left,
    y: workArea.y + top,
    width: right - left,
    height: bottom - top,
  };
}

function resolveCentPath() {
  const configured = process.env.KARTSTUDIO_CENT_BROWSER_PATH?.trim();
  const candidates = [configured, ...(process.platform === "win32" ? [
    path.join(process.env.LOCALAPPDATA ?? "", "CentBrowser", "Application", "chrome.exe"),
    path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "CentBrowser", "Application", "chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "CentBrowser", "Application", "chrome.exe"),
  ] : [])].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => path.isAbsolute(candidate) && existsSync(candidate) && statSync(candidate).isFile());
}

function profileDirectory(accountId: number) {
  const target = path.resolve(PROFILE_ROOT, `account-${accountId}`);
  if (!target.startsWith(`${path.resolve(PROFILE_ROOT)}${path.sep}`)) throw new Error("Invalid profile path.");
  return target;
}

async function launchOne(
  executable: string,
  accountId: number,
  workspaceId: string,
  bounds: WindowBounds,
): Promise<LaunchOutcome> {
  const profilePath = profileDirectory(accountId);
  mkdirSync(profilePath, { recursive: true });
  const prior = await prisma.browserProfile.findUnique({ where: { accountId }, select: { status: true } });
  if (prior?.status === "OPEN" || prior?.status === "STARTING") {
    return { error: "This account profile is already marked open. Close its Cent window before launching it again." };
  }
  await prisma.browserProfile.upsert({
    where: { accountId },
    update: { profilePath, status: "STARTING", lastStartedAt: new Date() },
    create: { accountId, profilePath, status: "STARTING", lastStartedAt: new Date() },
  });

  return new Promise((resolve) => {
    const child: ChildProcess = spawn(executable, [
      `--user-data-dir=${profilePath}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      "--no-first-run",
      `--window-position=${bounds.x},${bounds.y}`,
      `--window-size=${bounds.width},${bounds.height}`,
      "--new-window",
      FACEBOOK_LOGIN_URL,
    ], {
      detached: false,
      stdio: "ignore",
      windowsHide: false,
      shell: false,
    });
    let settled = false;
    let didSpawn = false;
    child.once("spawn", () => {
      settled = true;
      didSpawn = true;
      void prisma.browserProfile.update({ where: { accountId }, data: { status: "OPEN" } }).catch(() => undefined);
      void prisma.activityLog.create({ data: { workspaceId, accountId, type: "BROWSER_PROFILE_OPENED", message: "Dedicated Cent profile opened for user login." } }).catch(() => undefined);
      resolve({});
    });
    child.once("error", (error) => {
      void prisma.browserProfile.update({ where: { accountId }, data: { status: "ERROR" } }).catch(() => undefined);
      if (!settled) { settled = true; resolve({ error: error.message }); }
    });
    child.once("close", () => {
      if (didSpawn) void prisma.browserProfile.update({ where: { accountId }, data: { status: "CLOSED", lastClosedAt: new Date() } }).catch(() => undefined);
    });
  });
}

export async function launchLoginBatch(ids: number[]): Promise<LaunchResult> {
  if (process.platform !== "win32") throw new Error("Cent profile launching is currently supported on Windows only.");
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_BATCH_SIZE || ids.some((id) => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length) {
    throw new Error(`Choose between 1 and ${MAX_BATCH_SIZE} accounts for this batch.`);
  }
  const executable = resolveCentPath();
  if (!executable) throw new Error("Cent Browser was not found. Set KARTSTUDIO_CENT_BROWSER_PATH in frontend/.env.local to the full path of Cent's chrome.exe, then restart the app.");

  const workspace = await getLocalWorkspace();
  const accounts = await prisma.account.findMany({
    where: { id: { in: ids }, workspaceId: workspace.id, deletedAt: null },
    select: { id: true, username: true, credentials: { select: { username: true, password: true } } },
  });
  if (accounts.length !== ids.length) throw new Error("One or more selected accounts are unavailable. Refresh the account list and retry.");
  const orderedAccounts = [...accounts].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  const workArea = await getPrimaryWorkArea();

  const failed: string[] = [];
  const openedIds: number[] = [];
  const manualLoginIds: number[] = [];
  const populationErrors: string[] = [];

  // Open the full batch first; credential population runs only after this phase completes.
  for (const [index, account] of orderedAccounts.entries()) {
    try {
      const outcome = await launchOne(
        executable,
        account.id,
        workspace.id,
        tileBounds(workArea, index, orderedAccounts.length),
      );
      if (outcome.error) failed.push(`ACC-${String(account.id).padStart(6, "0")}: ${outcome.error}`);
      else openedIds.push(account.id);
    } catch (error) {
      failed.push(`ACC-${String(account.id).padStart(6, "0")}: ${error instanceof Error ? error.message : "Could not create browser profile."}`);
    }
  }

  // Only after every launch attempt, populate each successfully opened profile independently.
  for (const [index, account] of orderedAccounts.entries()) {
    if (!openedIds.includes(account.id)) continue;
    if (!account.credentials) {
      manualLoginIds.push(account.id);
      populationErrors.push(`ACC-${String(account.id).padStart(6, "0")}: No imported credentials are available.`);
      continue;
    }
    try {
      const submitted = await populateAndSubmitFacebookLogin(
        profileDirectory(account.id),
        {
          username: account.credentials.username ?? account.username ?? "",
          password: account.credentials.password,
        },
        tileBounds(workArea, index, orderedAccounts.length),
      );
      if (!submitted) {
        manualLoginIds.push(account.id);
        populationErrors.push(`ACC-${String(account.id).padStart(6, "0")}: Credentials were not submitted.`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown error";
      const safeReason = [account.credentials.username, account.username, account.credentials.password]
        .filter((value): value is string => Boolean(value))
        .reduce((message, secret) => message.split(secret).join("[redacted]"), reason)
        .slice(0, 240);
      console.error(`[facebook-login] Credentials could not be submitted for account ${account.id}: ${safeReason}`);
      manualLoginIds.push(account.id);
      populationErrors.push(`ACC-${String(account.id).padStart(6, "0")}: ${safeReason}`);
    }
  }

  return { openedIds, failed, manualLoginIds, populationErrors };
}
