"use server";

import { revalidatePath } from "next/cache";
import { getLocalWorkspace, prisma } from "@/lib/prisma";

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
