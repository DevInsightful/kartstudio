"use server";

import "server-only";
import path from "node:path";
import { closeCentProfiles, launchLoginBatch } from "@/app/accounts/login-actions";
import { waitForFacebookAuthentication } from "@/lib/cent-login-automation";
import { getLocalWorkspace, prisma } from "@/lib/prisma";
import { uploadViaProfessionalDashboard } from "@/lib/facebook-professional-dashboard-automation";

const MAX_FILES = 20;
const MAX_TOTAL_BYTES = 400 * 1024 * 1024;
const VIDEO_EXTENSION = /\.(mp4|mov|webm|m4v|3gp|avi|mkv)$/i;

export async function uploadProfessionalDashboardFiles(formData: FormData): Promise<{ message: string }> {
  let pageIds: unknown;
  try { pageIds = JSON.parse(String(formData.get("pageIds") ?? "")); } catch { throw new Error("Select Facebook Pages to upload to."); }
  if (!Array.isArray(pageIds) || !pageIds.length || pageIds.some((id) => typeof id !== "string")) throw new Error("Select at least one active Facebook Page.");
  if (new Set(pageIds).size !== pageIds.length) throw new Error("A Page can only be selected once.");
  const singlePageBatch = formData.get("singlePageBatch") === "true";
  if (singlePageBatch !== (pageIds.length === 1)) throw new Error("Select one Page for batch upload, or multiple Pages for one Reel per Page.");
  const batchSize = Number(formData.get("batchSize"));
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_FILES) throw new Error(`Batch size must be between 1 and ${MAX_FILES}.`);
  const description = String(formData.get("description") ?? "").trim();
  if (description.length > 5_000) throw new Error("Keep the Reel description under 5,000 characters.");
  const rawFiles = formData.getAll("videos");
  if (rawFiles.some((file) => !(file instanceof File))) throw new Error("Choose video files to upload.");
  const files = rawFiles as File[];
  if (!files.length || files.length > MAX_FILES) throw new Error(`Choose between 1 and ${MAX_FILES} videos.`);
  if (!singlePageBatch && files.length !== pageIds.length) throw new Error(`The number of selected Pages (${pageIds.length}) must match the number of videos (${files.length}).`);
  if (files.some((file) => !file.name || !VIDEO_EXTENSION.test(file.name) || file.size <= 0)) throw new Error("Choose non-empty MP4, MOV, WebM, M4V, 3GP, AVI, or MKV files.");
  if (files.reduce((total, file) => total + file.size, 0) > MAX_TOTAL_BYTES) throw new Error("Keep the total upload under 400 MB.");
  const uniqueNames = new Set(files.map((file) => file.name.toLocaleLowerCase()));
  if (uniqueNames.size !== files.length) throw new Error("Each video needs a different filename.");

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
    for (let cursor = 0; cursor < uploadFiles.length; cursor += batchSize) {
      const batch = uploadFiles.slice(cursor, cursor + batchSize);
      await ensureAuthenticated(accountId, profilePath);
      await uploadViaProfessionalDashboard(profilePath, page.name, batch.length === 1 ? "reel" : "bulk", batch, description);
      completed += batch.length;
      if (batch.length > 1) {
        const closed = await closeCentProfiles([accountId]);
        if (closed.failed.length) throw new Error(`The batch was saved, but Cent could not close before the next batch: ${closed.failed.join(" · ")}`);
      }
    }
  } else {
    for (let index = 0; index < orderedPages.length; index++) {
      const page = orderedPages[index];
      const accountId = page.accountId!;
      try {
        const profilePath = page.account?.browserProfile?.profilePath || path.join(process.cwd(), "data", "browser-profiles", `account-${accountId}`);
        await ensureAuthenticated(accountId, profilePath);
        await uploadViaProfessionalDashboard(profilePath, page.name, "reel", [uploadFiles[index]], description);
        completed++;
      } catch (error) { failures.push(`${page.name}: ${error instanceof Error ? error.message : "Upload failed."}`); }
    }
  }
  if (failures.length) throw new Error(`${completed} of ${files.length} videos were uploaded. ${failures.join(" · ")}`);
  const hasComposerForReview = !singlePageBatch || uploadFiles.some((_, index) => {
    const chunkStart = Math.floor(index / batchSize) * batchSize;
    return Math.min(batchSize, uploadFiles.length - chunkStart) === 1;
  });
  return { message: `Facebook finished the upload flow for ${completed} video${completed === 1 ? "" : "s"} across ${orderedPages.length} Page${orderedPages.length === 1 ? "" : "s"}. ${hasComposerForReview ? "Cent is left open for final Reel review; Publish/Share was not clicked." : "All bulk batches were saved and their Cent profiles were closed automatically."}` };
}
