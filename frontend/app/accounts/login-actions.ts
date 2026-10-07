"use server";

import "server-only";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { getLocalWorkspace, prisma } from "@/lib/prisma";

const MAX_BATCH_SIZE = 20;
const FACEBOOK_LOGIN_URL = "https://www.facebook.com/login/";
const PROFILE_ROOT = path.join(process.cwd(), "data", "browser-profiles");
type LaunchResult = { openedIds: number[]; failed: string[] };

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

async function launchOne(executable: string, accountId: number, workspaceId: string): Promise<string | null> {
  const profilePath = profileDirectory(accountId);
  mkdirSync(profilePath, { recursive: true });
  const prior = await prisma.browserProfile.findUnique({ where: { accountId }, select: { status: true } });
  if (prior?.status === "OPEN" || prior?.status === "STARTING") return "This account profile is already marked open. Close its Cent window before launching it again.";
  await prisma.browserProfile.upsert({
    where: { accountId },
    update: { profilePath, status: "STARTING", lastStartedAt: new Date() },
    create: { accountId, profilePath, status: "STARTING", lastStartedAt: new Date() },
  });

  return new Promise((resolve) => {
    const child: ChildProcess = spawn(executable, [`--user-data-dir=${profilePath}`, "--no-first-run", "--new-window", FACEBOOK_LOGIN_URL], {
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
      resolve(null);
    });
    child.once("error", (error) => {
      void prisma.browserProfile.update({ where: { accountId }, data: { status: "ERROR" } }).catch(() => undefined);
      if (!settled) { settled = true; resolve(error.message); }
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
  const accounts = await prisma.account.findMany({ where: { id: { in: ids }, workspaceId: workspace.id, deletedAt: null }, select: { id: true } });
  if (accounts.length !== ids.length) throw new Error("One or more selected accounts are unavailable. Refresh the account list and retry.");
  const orderedAccounts = [...accounts].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));

  const failed: string[] = [];
  const openedIds: number[] = [];
  for (const account of orderedAccounts) {
    try {
      const error = await launchOne(executable, account.id, workspace.id);
      if (error) failed.push(`ACC-${String(account.id).padStart(6, "0")}: ${error}`);
      else openedIds.push(account.id);
    } catch (error) {
      failed.push(`ACC-${String(account.id).padStart(6, "0")}: ${error instanceof Error ? error.message : "Could not create browser profile."}`);
    }
  }
  return { openedIds, failed };
}
