"use server";

import { revalidatePath } from "next/cache";
import { getLocalWorkspace, prisma } from "@/lib/prisma";

export async function recordLoginBatchResults(ids: number[], activeIds: number[]) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20 || ids.some((id) => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length) {
    throw new Error("Invalid login batch account list.");
  }
  if (!Array.isArray(activeIds) || activeIds.some((id) => !ids.includes(id)) || new Set(activeIds).size !== activeIds.length) {
    throw new Error("Invalid confirmed login account list.");
  }

  const workspace = await getLocalWorkspace();
  const accounts = await prisma.account.findMany({
    where: { id: { in: ids }, workspaceId: workspace.id, deletedAt: null },
    select: { id: true },
  });
  if (accounts.length !== ids.length) throw new Error("One or more accounts are no longer available.");

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    for (const id of ids) {
      const confirmed = activeIds.includes(id);
      const status = confirmed ? "ACTIVE" : "LOGIN_REQUIRED";
      await tx.browserProfile.updateMany({ where: { accountId: id }, data: { status: "CLOSED", lastClosedAt: now } });
      await tx.session.upsert({
        where: { accountId: id },
        update: { status, lastCheckedAt: now, ...(confirmed ? { lastAuthenticatedAt: now } : {}) },
        create: { accountId: id, status, lastCheckedAt: now, ...(confirmed ? { lastAuthenticatedAt: now } : {}) },
      });
      await tx.account.update({ where: { id }, data: { status } });
      await tx.activityLog.create({
        data: {
          workspaceId: workspace.id,
          accountId: id,
          type: confirmed ? "LOGIN_CONFIRMED_BY_USER" : "LOGIN_REQUIRED_CONFIRMED_BY_USER",
          message: confirmed ? "User confirmed login in the dedicated browser profile." : "User marked login as still required.",
        },
      });
    }
  });
  revalidatePath("/accounts");
}

export async function confirmProfilesClosed(ids: number[]) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20 || ids.some((id) => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length) {
    throw new Error("Invalid profile list.");
  }
  const workspace = await getLocalWorkspace();
  const accounts = await prisma.account.findMany({ where: { id: { in: ids }, workspaceId: workspace.id, deletedAt: null }, select: { id: true } });
  if (accounts.length !== ids.length) throw new Error("One or more selected accounts are no longer available.");
  const now = new Date();
  await prisma.browserProfile.updateMany({ where: { accountId: { in: ids } }, data: { status: "CLOSED", lastClosedAt: now } });
  revalidatePath("/accounts");
}
