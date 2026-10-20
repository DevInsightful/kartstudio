"use server";

import "server-only";
import path from "node:path";
import { revalidatePath } from "next/cache";
import { closeCentProfiles, launchLoginBatch } from "@/app/accounts/login-actions";
import { getLocalWorkspace, prisma } from "@/lib/prisma";
import { publishFacebookReel } from "@/lib/facebook-reels-automation";

const PROFILE_ROOT = path.join(process.cwd(), "data", "browser-profiles");
const MAX_VIDEO_BYTES = 400 * 1024 * 1024;
const VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm", "video/x-m4v", "video/3gpp", "video/x-msvideo", "video/x-matroska"]);

function idArray(value: FormDataEntryValue | null, label: string) {
  if (typeof value !== "string") throw new Error(`The ${label} list is missing.`);
  let data: unknown;
  try { data = JSON.parse(value); } catch { throw new Error(`The ${label} list is invalid.`); }
  if (!Array.isArray(data) || data.some((id) => typeof id !== "string" || !id) || new Set(data).size !== data.length) {
    throw new Error(`The ${label} list is invalid.`);
  }
  return data as string[];
}

function indexArray(value: FormDataEntryValue | null, total: number) {
  if (typeof value !== "string") throw new Error("The batch position list is missing.");
  let data: unknown;
  try { data = JSON.parse(value); } catch { throw new Error("The batch position list is invalid."); }
  if (!Array.isArray(data) || !data.length || data.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= total) || new Set(data).size !== data.length) {
    throw new Error("The batch position list is invalid.");
  }
  return data as number[];
}

export async function publishReelGroup(formData: FormData): Promise<{ results: { pageId: string; pageName: string; status: "PUBLISHED" | "FAILED"; message: string }[] }> {
  const pageIds = idArray(formData.get("pageIds"), "selected Page");
  if (!pageIds.length || pageIds.length > 500) throw new Error("Select between 1 and 500 Pages per run.");
  const indexes = indexArray(formData.get("groupIndexes"), pageIds.length);
  if (indexes.length > 20) throw new Error("A posting batch can contain up to 20 Page jobs.");
  const groupIds = indexes.map((index) => pageIds[index]);
  const descriptionValue = formData.get("descriptions");
  if (typeof descriptionValue !== "string") throw new Error("Descriptions are missing.");
  let descriptions: unknown;
  try { descriptions = JSON.parse(descriptionValue); } catch { throw new Error("Descriptions are invalid."); }
  if (!Array.isArray(descriptions) || descriptions.length !== pageIds.length || descriptions.some((description) => typeof description !== "string" || description.length > 5000)) {
    throw new Error("Enter one description for each selected Page or choose the shared-description option.");
  }
  const videoFiles = formData.getAll("videos");
  if (videoFiles.length !== indexes.length || videoFiles.some((file) => !(file instanceof File))) {
    throw new Error(`This group needs exactly ${indexes.length} video files.`);
  }
  const videos = videoFiles as File[];
  if (videos.some((file) => !file.name || file.size <= 0 || file.size > MAX_VIDEO_BYTES || !VIDEO_TYPES.has(file.type.toLowerCase()))) {
    throw new Error("Choose MP4, MOV, WebM, M4V, 3GP, AVI, or MKV videos. Each file must be under 400 MB.");
  }
  if (videos.reduce((total, file) => total + file.size, 0) > MAX_VIDEO_BYTES) {
    throw new Error("Keep each upload batch under 400 MB. Choose fewer jobs at once or use smaller videos.");
  }

  const workspace = await getLocalWorkspace();
  const pages = await prisma.page.findMany({
    where: {
      id: { in: pageIds }, workspaceId: workspace.id, status: "ACTIVE",
      account: { is: { status: "ACTIVE", deletedAt: null, platform: "FACEBOOK" } },
    },
    select: { id: true, name: true, accountId: true, account: { select: { browserProfile: { select: { profilePath: true, status: true } } } } },
  });
  if (pages.length !== pageIds.length || pages.some((page) => page.accountId === null)) {
    throw new Error("One or more selected Pages are no longer active. Refresh and select them again.");
  }
  const pageById = new Map(pages.map((page) => [page.id, page]));
  const groupPages = groupIds.map((id) => pageById.get(id)!);
  const accountIds = groupPages.map((page) => page.accountId!);
  if (new Set(accountIds).size !== accountIds.length) {
    throw new Error("A batch cannot open the same Facebook account twice. Reduce concurrency or reorder the selected Pages.");
  }

  const videosByIndex = new Map(indexes.map((index, local) => [index, videos[local]]));
  const createdRecords = await Promise.all(indexes.map((index) => {
    const page = pageById.get(pageIds[index])!;
    const video = videosByIndex.get(index)!;
    return prisma.reelPost.create({
      data: { workspaceId: workspace.id, pageId: page.id, videoName: video.name, description: descriptions[index] as string, status: "PROCESSING" },
      select: { id: true },
    });
  }));

  const wasOpen = new Set(groupPages.filter((page) => page.account!.browserProfile?.status === "OPEN").map((page) => page.accountId!));
  const results: { pageId: string; pageName: string; status: "PUBLISHED" | "FAILED"; message: string }[] = [];
  let openedByThisRun: number[] = [];
  try {
    const launch = await launchLoginBatch(accountIds, { reuseOpenProfiles: true });
    openedByThisRun = launch.openedIds.filter((id) => !wasOpen.has(id));
    const authenticated = new Set(launch.authenticatedIds);
    await Promise.all(groupPages.map(async (page, localIndex) => {
      const recordId = createdRecords[localIndex].id;
      const pageId = page.id;
      if (!authenticated.has(page.accountId!)) {
        const message = launch.failed.find((item) => item.startsWith(`ACC-${String(page.accountId).padStart(6, "0")}:`)) ??
          launch.populationErrors.find((item) => item.startsWith(`ACC-${String(page.accountId).padStart(6, "0")}:`)) ??
          "Facebook login could not be verified. This Reel was not published.";
        await prisma.reelPost.update({ where: { id: recordId }, data: { status: "FAILED", error: message } });
        results.push({ pageId, pageName: page.name, status: "FAILED", message });
        return;
      }
      const video = videosByIndex.get(indexes[localIndex])!;
      try {
        const profilePath = page.account!.browserProfile?.profilePath || path.join(PROFILE_ROOT, `account-${page.accountId}`);
        await publishFacebookReel(profilePath, {
          pageName: page.name,
          videoName: video.name,
          description: descriptions[indexes[localIndex]] as string,
          video: new Uint8Array(await video.arrayBuffer()),
        });
        await prisma.reelPost.update({ where: { id: recordId }, data: { status: "PUBLISHED", postedAt: new Date(), error: null } });
        results.push({ pageId, pageName: page.name, status: "PUBLISHED", message: "Facebook confirmed the publish flow." });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Facebook did not confirm this Reel.";
        await prisma.reelPost.update({ where: { id: recordId }, data: { status: "FAILED", error: message } });
        results.push({ pageId, pageName: page.name, status: "FAILED", message });
      }
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "This posting batch could not start.";
    await Promise.all(createdRecords.map((record, localIndex) => {
      const index = indexes[localIndex];
      const page = pageById.get(pageIds[index])!;
      results.push({ pageId: page.id, pageName: page.name, status: "FAILED", message });
      return prisma.reelPost.update({ where: { id: record.id }, data: { status: "FAILED", error: message } });
    }));
  } finally {
    const failedAccountIds = new Set(results
      .filter((result) => result.status === "FAILED")
      .map((result) => pageById.get(result.pageId)?.accountId)
      .filter((accountId): accountId is number => typeof accountId === "number"));
    const profilesToClose = openedByThisRun.filter((accountId) => !failedAccountIds.has(accountId));
    if (profilesToClose.length) await closeCentProfiles(profilesToClose).catch(() => undefined);
  }
  revalidatePath("/publishing/reels");
  revalidatePath("/publishing/published");
  return { results };
}
