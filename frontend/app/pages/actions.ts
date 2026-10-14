"use server";

import "server-only";
import { createHash } from "node:crypto";
import path from "node:path";
import { getLocalWorkspace, prisma } from "@/lib/prisma";
import { populateFacebookPageForm } from "@/lib/cent-login-automation";
import { parsePageDetailsCsv } from "@/lib/page-details-csv";
import { closeCentProfiles, launchLoginBatch } from "@/app/accounts/login-actions";

const PROFILE_ROOT = path.join(process.cwd(), "data", "browser-profiles");
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/tiff",
  "image/heic",
  "image/heif",
  "image/avif",
]);

type PopulateResult = { state: "images-uploaded" | "completion-unconfirmed" | "next-clicked" | "created-clicked" | "login-required" | "checkpoint" | "category-unselected" | "create-button-unavailable" | "next-button-unavailable" | "image-upload-unavailable" | "post-upload-step-unavailable" | "fields-unverified" | "category-unverified" | "form-unavailable"; message: string };

const MAX_PAGE_RUN_ACCOUNTS = 500;
const MAX_PAGE_IMAGE_SIZE = 10 * 1024 * 1024;
const PAGE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp", "image/tiff", "image/heic", "image/heif", "image/avif"]);

function parseIdList(value: FormDataEntryValue | null, label: string) {
  if (typeof value !== "string") throw new Error(`The ${label} account list is missing.`);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(`The ${label} account list is invalid.`); }
  if (!Array.isArray(parsed) || parsed.some((id) => !Number.isSafeInteger(id) || id < 1) || new Set(parsed).size !== parsed.length) {
    throw new Error(`The ${label} account list is invalid.`);
  }
  return parsed as number[];
}

export async function runPageCreationGroup(formData: FormData): Promise<{ completedIds: number[]; failed: string[]; openForReviewIds: number[] }> {
  const allIds = parseIdList(formData.get("allAccountIds"), "selected");
  const groupIds = parseIdList(formData.get("groupAccountIds"), "job group");
  if (!allIds.length || allIds.length > MAX_PAGE_RUN_ACCOUNTS) throw new Error(`Select between 1 and ${MAX_PAGE_RUN_ACCOUNTS} accounts per run.`);
  const groupStart = Number(formData.get("groupStart"));
  if (!Number.isSafeInteger(groupStart) || groupStart < 0 || groupStart + groupIds.length > allIds.length) {
    throw new Error("The current job group position is invalid.");
  }
  if (!groupIds.length || groupIds.length > 20 || groupIds.some((id, index) => allIds[groupStart + index] !== id)) {
    throw new Error("The current job group does not match the selected account order.");
  }
  const categoryValue = formData.get("category");
  const category = typeof categoryValue === "string" ? categoryValue.trim() : "";
  if (!category || category.length > 100) throw new Error("Choose a valid Page category.");

  const detailsFile = formData.get("detailsCsv");
  if (!(detailsFile instanceof File) || detailsFile.size > 2 * 1024 * 1024) throw new Error("Choose a names and bios CSV file under 2 MB.");
  const details = parsePageDetailsCsv(await detailsFile.text());
  if (details.length !== allIds.length) throw new Error(`The CSV has ${details.length} name/bio rows, but ${allIds.length} accounts are selected. Make the counts match.`);
  for (const [index, detail] of details.entries()) {
    if (!detail.name || detail.name.length > 75) throw new Error(`CSV row ${index + 2} needs a Page name from 1 to 75 characters.`);
    if (!detail.bio || detail.bio.length > 500) throw new Error(`CSV row ${index + 2} needs a bio from 1 to 500 characters.`);
  }

  const profileFiles = formData.getAll("profileImages");
  const coverFiles = formData.getAll("coverImages");
  if (profileFiles.length !== groupIds.length || coverFiles.length !== groupIds.length ||
      profileFiles.some((file) => !(file instanceof File)) || coverFiles.some((file) => !(file instanceof File))) {
    throw new Error(`This group needs exactly ${groupIds.length} profile images and ${groupIds.length} cover images.`);
  }
  const imageFiles = [...profileFiles, ...coverFiles] as File[];
  for (const file of imageFiles) {
    if (!PAGE_IMAGE_TYPES.has(file.type.toLowerCase())) throw new Error(`${file.name} is not a supported image type.`);
    if (file.size <= 0 || file.size > MAX_PAGE_IMAGE_SIZE) throw new Error(`${file.name} must be between 1 byte and 10 MB.`);
  }
  const imageHashes = new Set<string>();
  for (const file of imageFiles) {
    const hash = createHash("sha256").update(Buffer.from(await file.arrayBuffer())).digest("hex");
    if (imageHashes.has(hash)) throw new Error("These profile and cover folders contain duplicate image content. Remove duplicate files and retry.");
    imageHashes.add(hash);
  }

  const workspace = await getLocalWorkspace();
  const eligible = await prisma.account.findMany({
    where: { id: { in: allIds }, workspaceId: workspace.id, deletedAt: null, status: "ACTIVE", platform: "FACEBOOK" },
    select: { id: true },
  });
  if (eligible.length !== allIds.length) throw new Error("Every selected account must be active, available, and a Facebook account. Refresh the list and select active accounts.");

  const completedIds: number[] = [];
  const failed: string[] = [];
  const openForReviewIds: number[] = [];
  try {
    const launch = await launchLoginBatch(groupIds, { reuseOpenProfiles: true });
    failed.push(...launch.failed);
    const authenticatedIds = new Set(launch.authenticatedIds);
    for (const id of groupIds) {
      if (authenticatedIds.has(id)) continue;
      if (launch.failed.some((message) => message.includes(`ACC-${String(id).padStart(6, "0")}:`))) continue;
      const message = launch.populationErrors.find((entry) => entry.startsWith(`ACC-${String(id).padStart(6, "0")}:`));
      failed.push(message ?? `ACC-${String(id).padStart(6, "0")}: Facebook login could not be verified.`);
    }

    const readyIds = groupIds.filter((id) => authenticatedIds.has(id));
    const results = await Promise.all(readyIds.map(async (id) => {
      const index = allIds.indexOf(id);
      const localIndex = index - groupStart;
      try {
        const profile = await prisma.browserProfile.findUnique({ where: { accountId: id }, select: { profilePath: true } });
        const result = await populateFacebookPageForm(profile?.profilePath || path.join(PROFILE_ROOT, `account-${id}`), {
          name: details[index].name,
          category,
          bio: details[index].bio,
        }, {
          profileImage: new Uint8Array(await (profileFiles[localIndex] as File).arrayBuffer()),
          profileImageType: (profileFiles[localIndex] as File).type,
          coverImage: new Uint8Array(await (coverFiles[localIndex] as File).arrayBuffer()),
          coverImageType: (coverFiles[localIndex] as File).type,
        });
        if (result === "images-uploaded") return { id, success: true as const };
        if (result === "completion-unconfirmed") {
          return { id, success: false as const, keepOpen: true as const,
            message: "Facebook did not confirm the final Page save. The Cent profile was left open for review; check it before retrying to avoid creating a duplicate." };
        }
        return { id, success: false as const, message: `Facebook automation stopped with status: ${result}.` };
      } catch (error) {
        return { id, success: false as const, message: error instanceof Error ? error.message : "Page creation failed." };
      }
    }));
    for (const result of results) {
      const prefix = `ACC-${String(result.id).padStart(6, "0")}:`;
      if (result.success) completedIds.push(result.id);
      else {
        if ("keepOpen" in result && result.keepOpen) openForReviewIds.push(result.id);
        failed.push(`${prefix} ${result.message}`);
      }
    }
  } finally {
    const closed = await closeCentProfiles(groupIds.filter((id) => !openForReviewIds.includes(id)));
    failed.push(...closed.failed);
  }
  return { completedIds, failed, openForReviewIds };
}

export async function populatePageForm(formData: FormData): Promise<PopulateResult> {
  const accountValue = formData.get("accountId");
  const nameValue = formData.get("name");
  const categoryValue = formData.get("category");
  const bioValue = formData.get("bio");
  const profileImage = formData.get("profileImage");
  const coverImage = formData.get("coverImage");
  if (typeof accountValue !== "string") throw new Error("Choose a valid Facebook account.");
  if (typeof nameValue !== "string" || typeof categoryValue !== "string" || typeof bioValue !== "string") {
    throw new Error("Enter a Page name, category, and bio.");
  }
  if (!(profileImage instanceof File) || profileImage.size === 0) throw new Error("Choose a profile picture.");
  if (!(coverImage instanceof File) || coverImage.size === 0) throw new Error("Choose a cover photo.");
  for (const [label, image] of [["Profile picture", profileImage], ["Cover photo", coverImage]] as const) {
    if (!ALLOWED_IMAGE_TYPES.has(image.type.toLowerCase())) {
      throw new Error(`${label} must be a JPEG, PNG, WebP, GIF, BMP, TIFF, HEIC, HEIF, or AVIF image.`);
    }
    if (image.size > MAX_IMAGE_SIZE) throw new Error(`${label} must be 10 MB or smaller.`);
  }

  const accountId = Number(accountValue);
  if (!Number.isSafeInteger(accountId) || accountId < 1) throw new Error("Choose a valid Facebook account.");
  const pageName = nameValue.trim();
  const pageCategory = categoryValue.trim();
  const pageBio = bioValue.trim();
  if (!pageName || pageName.length > 75) throw new Error("Enter a Page name between 1 and 75 characters.");
  if (!pageCategory || pageCategory.length > 100) throw new Error("Enter a Page category between 1 and 100 characters.");
  if (!pageBio || pageBio.length > 500) throw new Error("Enter a Page bio between 1 and 500 characters.");

  const workspace = await getLocalWorkspace();
  const account = await prisma.account.findFirst({
    where: { id: accountId, workspaceId: workspace.id, deletedAt: null, status: "ACTIVE" },
    select: { id: true, browserProfile: { select: { profilePath: true, status: true } } },
  });
  if (!account) throw new Error("This account is not marked active. Confirm its Facebook login before using it.");

  let profilePath = account.browserProfile?.profilePath;
  if (account.browserProfile?.status !== "OPEN") {
    const launch = await launchLoginBatch([account.id]);
    if (!launch.openedIds.includes(account.id)) {
      throw new Error(launch.failed.join(" ") || "Could not open this account's Cent profile.");
    }
    if (!launch.authenticatedIds.includes(account.id)) {
      throw new Error(launch.populationErrors.join(" ") || "Facebook login could not be verified for this account.");
    }
    const profile = await prisma.browserProfile.findUnique({
      where: { accountId: account.id },
      select: { profilePath: true },
    });
    profilePath = profile?.profilePath;
  }
  if (!profilePath) {
    profilePath = path.join(PROFILE_ROOT, `account-${account.id}`);
  }

  const result = await populateFacebookPageForm(profilePath, {
    name: pageName,
    category: pageCategory,
    bio: pageBio,
  }, {
    profileImage: new Uint8Array(await profileImage.arrayBuffer()),
    profileImageType: profileImage.type,
    coverImage: new Uint8Array(await coverImage.arrayBuffer()),
    coverImageType: coverImage.type,
  });
  if (result === "images-uploaded") {
    return {
      state: result,
      message: "Facebook's profile and cover images were uploaded, and Facebook confirmed the Page after the Next → Skip → Next → Done sequence.",
    };
  }
  if (result === "completion-unconfirmed") {
    return {
      state: result,
      message: "Facebook did not confirm the final Page save. The Cent profile was left open for review; check Facebook before retrying to avoid creating a duplicate.",
    };
  }
  if (result === "next-clicked") {
    return {
      state: result,
      message: "Create Page was clicked. After Facebook displayed the follow-up screen, the helper waited 2.5 seconds and clicked Next once.",
    };
  }
  if (result === "created-clicked") {
    return {
      state: result,
      message: "The Create Page click was sent, but Facebook's Next button was not confirmed. Check the Cent window and continue manually if needed.",
    };
  }
  if (result === "login-required") {
    return { state: result, message: "Facebook is not signed in for this profile. Sign in manually in Cent, then try again." };
  }
  if (result === "checkpoint") {
    return { state: result, message: "Facebook requires a checkpoint or two-factor verification. Complete it manually in Cent, then try again." };
  }
  if (result === "category-unselected") {
    return {
      state: result,
      message: "The Page name and bio were populated, but Facebook did not confirm a selected category chip. Select one of the visible suggestions manually in Cent before continuing.",
    };
  }
  if (result === "fields-unverified") {
    return {
      state: result,
      message: "Facebook did not expose the populated Page name or bio in a form field the helper could verify. The Create Page button was not clicked. Check the form in Cent and review the server log for which field failed verification.",
    };
  }
  if (result === "category-unverified") {
    return {
      state: result,
      message: "Facebook did not expose the chosen category as a selected category chip. The Create Page button was not clicked. Select the category from Facebook's suggestions in Cent and try again.",
    };
  }
  if (result === "create-button-unavailable") {
    return {
      state: result,
      message: "The name, bio, and category were populated, but an enabled Create Page button was not found. Review the form and submit manually in Cent.",
    };
  }
  if (result === "next-button-unavailable") {
    return {
      state: result,
      message: "Create Page was clicked, but Facebook's visible Next button did not appear within the wait period. Check the Cent window and continue manually if needed.",
    };
  }
  if (result === "image-upload-unavailable") {
    return {
      state: result,
      message: "Facebook did not confirm that both profile and cover image uploads completed successfully. The helper left Cent on the current setup step; check the upload status before continuing.",
    };
  }
  if (result === "post-upload-step-unavailable") {
    return {
      state: result,
      message: "The profile and cover images were attached, but Facebook did not show the next expected button in the Next → Skip → Next → Done sequence. Check Cent and continue manually from the current screen.",
    };
  }
  if (result === "form-unavailable") {
    return {
      state: result,
      message: "Facebook redirected away from the Page form or its required fields did not finish loading. Check the Cent tab for a login, checkpoint, or error screen and try again after resolving it.",
    };
  }
  return {
    state: result,
    message: "Facebook returned an unexpected Page automation state. Check the Cent tab and server logs before continuing.",
  };
}
