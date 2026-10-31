"use server";

import "server-only";
import path from "node:path";
import { closeCentProfiles, launchLoginBatch } from "@/app/accounts/login-actions";
import { waitForFacebookAuthentication } from "@/lib/cent-login-automation";
import { getLocalWorkspace, prisma } from "@/lib/prisma";
import { uploadViaProfessionalDashboard } from "@/lib/facebook-professional-dashboard-automation";

const MAX_FILES_PER_PAGE = 20;
const MAX_TOTAL_FILES = 100;
const MAX_TOTAL_BYTES = 400 * 1024 * 1024;
const VIDEO_EXTENSION = /\.(mp4|mov|webm|m4v|3gp|avi|mkv)$/i;

export async function uploadProfessionalDashboardFiles(formData: FormData): Promise<{ message: string }> {
  let pageIds: unknown;
  try { pageIds = JSON.parse(String(formData.get("pageIds") ?? "")); } catch { throw new Error("Select Facebook Pages to upload to."); }
  if (!Array.isArray(pageIds) || !pageIds.length || pageIds.some((id) => typeof id !== "string")) throw new Error("Select at least one active Facebook Page.");
  if (new Set(pageIds).size !== pageIds.length) throw new Error("A Page can only be selected once.");
  const singlePageBatch = formData.get("singlePageBatch") === "true";
  const sameVideosForAllPages = !singlePageBatch && formData.get("sameVideosForAllPages") === "true";
  if (singlePageBatch !== (pageIds.length === 1)) throw new Error("Select one Page for batch upload, or multiple Pages for one Reel per Page.");
  const batchSize = Number(formData.get("batchSize"));
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_FILES_PER_PAGE) throw new Error(`Batch size must be between 1 and ${MAX_FILES_PER_PAGE}.`);
  const description = String(formData.get("description") ?? "").trim();
  if (description.length > 5_000) throw new Error("Keep the Reel description under 5,000 characters.");
  let pageVideoCounts: number[] = [];
  if (!singlePageBatch) {
    try { pageVideoCounts = JSON.parse(String(formData.get("pageVideoCounts") ?? "")) as number[]; }
    catch { throw new Error("Choose a video folder for every selected Page."); }
    if (!Array.isArray(pageVideoCounts) || pageVideoCounts.length !== pageIds.length || pageVideoCounts.some((count) => !Number.isInteger(count) || count < 1 || count > MAX_FILES_PER_PAGE)) {
      throw new Error(`Choose 1 to ${MAX_FILES_PER_PAGE} videos for each selected Page.`);
    }
  }
  const rawFiles = formData.getAll("videos");
  if (rawFiles.some((file) => !(file instanceof File))) throw new Error("Choose video files to upload.");
  const files = rawFiles as File[];
  if (!files.length || files.length > MAX_TOTAL_FILES) throw new Error(`Choose between 1 and ${MAX_TOTAL_FILES} videos per run.`);
  const assignedVideoCount = singlePageBatch ? files.length : pageVideoCounts.reduce((total, count) => total + count, 0);
  if (!singlePageBatch && sameVideosForAllPages) {
    if (pageVideoCounts.some((count) => count !== pageVideoCounts[0]) || pageVideoCounts[0] !== files.length) throw new Error("Choose one shared folder of videos for every selected Page.");
  } else if (!singlePageBatch && assignedVideoCount !== files.length) throw new Error("The video folders must contain exactly the videos listed for the selected Pages.");
  if (assignedVideoCount > MAX_TOTAL_FILES) throw new Error(`Choose no more than ${MAX_TOTAL_FILES} total Page video uploads per run.`);
  if (files.some((file) => !file.name || !VIDEO_EXTENSION.test(file.name) || file.size <= 0)) throw new Error("Choose non-empty MP4, MOV, WebM, M4V, 3GP, AVI, or MKV files.");
  if (files.reduce((total, file) => total + file.size, 0) * (sameVideosForAllPages ? pageIds.length : 1) > MAX_TOTAL_BYTES) throw new Error("Keep the total upload under 400 MB across all selected Pages.");
  if (singlePageBatch) {
    if (files.length > MAX_FILES_PER_PAGE) throw new Error(`Choose no more than ${MAX_FILES_PER_PAGE} videos for one Page per run.`);
    const uniqueNames = new Set(files.map((file) => file.name.toLocaleLowerCase()));
    if (uniqueNames.size !== files.length) throw new Error("Each video needs a different filename.");
  } else {
    let offset = 0;
    for (const count of sameVideosForAllPages ? [files.length] : pageVideoCounts) {
      const names = new Set(files.slice(offset, offset + count).map((file) => file.name.toLocaleLowerCase()));
      if (names.size !== count) throw new Error("Each Page folder must have different video filenames.");
      offset += count;
    }
  }

  const workspace = await getLocalWorkspace();
  const pages = await prisma.page.findMany({
    where: { id: { in: pageIds as string[] }, workspaceId: workspace.id, status: "ACTIVE", account: { is: { platform: "FACEBOOK", status: "ACTIVE", deletedAt: null } } },
    select: { id: true, name: true, accountId: true, account: { select: { id: true, browserProfile: { select: { profilePath: true } } } } },
  });
  if (pages.length !== pageIds.length || pages.some((page) => !page.account)) throw new Error("One or more selected Pages are no longer active. Refresh and choose active Pages again.");
  const orderedPages = pageIds.map((id) => pages.find((page) => page.id === id)!);
  const uploadFiles = await Promise.all(files.map(async (file) => ({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) })));
  let completed = 0;
  const failures: string[] = [];

  async function ensureAuthenticated(accountId: number, profilePath: string) {
    const launch = await launchLoginBatch([accountId], { reuseOpenProfiles: true });
    if (launch.authenticatedIds.includes(accountId)) return;
    const opened = launch.openedIds.includes(accountId);
    if (opened && !launch.failed.some((message) => message.startsWith(`ACC-${String(accountId).padStart(6, "0")}:`))) {
      const authenticated = await waitForFacebookAuthentication(profilePath);
      if (authenticated) return;
      throw new Error("Facebook sign-in was not completed within 5 minutes. The Cent profile remains open; finish sign-in and start the upload again.");
    }
    throw new Error(launch.failed[0] ?? launch.populationErrors[0] ?? "Facebook login could not be verified; the Cent profile remains open for review.");
  }

  if (singlePageBatch) {
    const page = orderedPages[0];
    const accountId = page.accountId!;
    const profilePath = page.account?.browserProfile?.profilePath || path.join(process.cwd(), "data", "browser-profiles", `account-${accountId}`);
    await ensureAuthenticated(accountId, profilePath);
    await uploadViaProfessionalDashboard(profilePath, page.name, "bulk", uploadFiles, description);
    completed += uploadFiles.length;
    const closed = await closeCentProfiles([accountId]);
    if (closed.failed.length) throw new Error(`The upload was saved, but Cent could not close: ${closed.failed.join(" · ")}`);
  } else {
    let offset = 0;
    const jobs = orderedPages.map((page, index) => {
      const count = pageVideoCounts[index];
      const job = { page, files: sameVideosForAllPages ? uploadFiles : uploadFiles.slice(offset, offset + count) };
      if (!sameVideosForAllPages) offset += count;
      return job;
    });
    const batches: typeof jobs[] = [];
    for (const job of jobs) {
      let batch = batches.find((candidate) => candidate.length < batchSize && !candidate.some((item) => item.page.accountId === job.page.accountId));
      if (!batch) { batch = []; batches.push(batch); }
      batch.push(job);
    }
    for (const batch of batches) {
      const accountIds = batch.map(({ page }) => page.accountId!);
      const authenticationErrors = new Map<number, string>();
      try {
        const launch = await launchLoginBatch(accountIds, { reuseOpenProfiles: true });
        await Promise.all(accountIds.map(async (accountId) => {
          if (launch.authenticatedIds.includes(accountId)) return;
          const prefix = `ACC-${String(accountId).padStart(6, "0")}:`;
          if (!launch.openedIds.includes(accountId) || launch.failed.some((message) => message.startsWith(prefix))) {
            authenticationErrors.set(accountId, launch.failed.find((message) => message.startsWith(prefix)) ?? launch.populationErrors.find((message) => message.startsWith(prefix)) ?? "Facebook login could not be verified; the Cent profile remains open for review.");
            return;
          }
          const page = batch.find((job) => job.page.accountId === accountId)!.page;
          const profilePath = page.account?.browserProfile?.profilePath || path.join(process.cwd(), "data", "browser-profiles", `account-${accountId}`);
          if (!await waitForFacebookAuthentication(profilePath)) authenticationErrors.set(accountId, "Facebook sign-in was not completed within 5 minutes. The Cent profile remains open; finish sign-in and start the upload again.");
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Facebook profiles could not be opened for this batch.";
        accountIds.forEach((accountId) => authenticationErrors.set(accountId, message));
      }
      await Promise.all(batch.map(async ({ page, files: pageFiles }) => {
        const accountId = page.accountId!;
        try {
          const authenticationError = authenticationErrors.get(accountId);
          if (authenticationError) throw new Error(authenticationError);
          const profilePath = page.account?.browserProfile?.profilePath || path.join(process.cwd(), "data", "browser-profiles", `account-${accountId}`);
          await uploadViaProfessionalDashboard(profilePath, page.name, "bulk", pageFiles, description);
          completed += pageFiles.length;
          const closed = await closeCentProfiles([accountId]);
          if (closed.failed.length) throw new Error(`The videos were saved, but Cent could not close: ${closed.failed.join(" · ")}`);
        } catch (error) { failures.push(`${page.name}: ${error instanceof Error ? error.message : "Upload failed."}`); }
      }));
    }
  }
  if (failures.length) throw new Error(`${completed} of ${files.length} videos were uploaded. ${failures.join(" · ")}`);
  return { message: `Facebook finished the upload flow for ${completed} video${completed === 1 ? "" : "s"} across ${orderedPages.length} Page${orderedPages.length === 1 ? "" : "s"}. All bulk uploads were saved to Content Library and their Cent profiles were closed automatically.` };
}
