"use server";

import "server-only";
import path from "node:path";
import { getLocalWorkspace, prisma } from "@/lib/prisma";
import { populateFacebookPageForm } from "@/lib/cent-login-automation";
import { launchLoginBatch } from "@/app/accounts/login-actions";

const PROFILE_ROOT = path.join(process.cwd(), "data", "browser-profiles");

type PopulateResult = { state: "created-clicked" | "login-required" | "checkpoint" | "category-unselected" | "create-button-unavailable" | "fields-unverified" | "category-unverified" | "unverified"; message: string };

export async function populatePageForm(
  accountId: number,
  name: string,
  category: string,
  bio: string,
): Promise<PopulateResult> {
  if (!Number.isSafeInteger(accountId) || accountId < 1) throw new Error("Choose a valid Facebook account.");
  const pageName = name.trim();
  const pageCategory = category.trim();
  const pageBio = bio.trim();
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
  });
  if (result === "created-clicked") {
    return {
      state: result,
      message: "The Create Page click was sent after the name, bio, and category were verified. If the button remained visible and enabled after one second, the helper retried once using browser mouse input. Check the Cent window for Facebook's response.",
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
      message: "The Page name and bio were populated, but Facebook did not show an exact matching category suggestion. Select the category manually in Cent before continuing.",
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
  return {
    state: result,
    message: "The Facebook Page form or required fields were not recognized. The browser is open for you to continue manually.",
  };
}
