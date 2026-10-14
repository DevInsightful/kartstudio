"use server";

import "server-only";
import path from "node:path";
import { getLocalWorkspace, prisma } from "@/lib/prisma";
import { populateFacebookPageForm } from "@/lib/cent-login-automation";
import { launchLoginBatch } from "@/app/accounts/login-actions";

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

type PopulateResult = { state: "images-uploaded" | "next-clicked" | "created-clicked" | "login-required" | "checkpoint" | "category-unselected" | "create-button-unavailable" | "next-button-unavailable" | "image-upload-unavailable" | "post-upload-step-unavailable" | "fields-unverified" | "category-unverified" | "form-unavailable"; message: string };

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
      message: "Facebook's profile and cover images were attached, then the Next → Skip → Next → Done sequence was completed. Check the Cent window for Facebook's final confirmation.",
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
      message: "Facebook's profile picture and cover upload controls did not appear after Next. The browser is open; add both images manually in Cent.",
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
