"use server";
import { revalidatePath } from "next/cache";
import { getLocalWorkspace, prisma } from "@/lib/prisma";

function selectedIds(data: FormData) {
  const ids = [...new Set(data.getAll("ids").map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length || ids.length > 5000) throw new Error("Select between 1 and 5000 accounts.");
  return ids;
}
function read(data: FormData, key: string) { const value = data.get(key); return typeof value === "string" ? value.trim() : ""; }

export async function assignCategory(data: FormData) {
  const ids = selectedIds(data); const workspace = await getLocalWorkspace();
  const name = read(data, "newCategory"); const categoryId = read(data, "categoryId");
  if (!name && !categoryId) throw new Error("Choose or create a category.");
  const category = name ? await prisma.category.upsert({ where: { workspaceId_name: { workspaceId: workspace.id, name } }, update: {}, create: { workspaceId: workspace.id, name } }) : await prisma.category.findFirst({ where: { id: categoryId, workspaceId: workspace.id } });
  if (!category) throw new Error("Category not found.");
  await prisma.account.updateMany({ where: { id: { in: ids }, workspaceId: workspace.id, deletedAt: null }, data: { categoryId: category.id } });
  revalidatePath("/accounts");
}

export async function addTags(data: FormData) {
  const ids = selectedIds(data); const workspace = await getLocalWorkspace();
  const validAccounts = await prisma.account.findMany({ where: { id: { in: ids }, workspaceId: workspace.id, deletedAt: null }, select: { id: true } });
  const validIds = validAccounts.map(({ id }) => id);
  if (!validIds.length) throw new Error("No active accounts were selected.");
  const names = [...new Set(read(data, "tags").split(",").map((x) => x.trim()).filter((x) => x && x.length <= 40))];
  if (!names.length) throw new Error("Enter at least one tag.");
  for (const name of names) {
    const tag = await prisma.tag.upsert({ where: { workspaceId_name: { workspaceId: workspace.id, name } }, update: {}, create: { workspaceId: workspace.id, name } });
    await prisma.$transaction(async (tx) => {
      const existing = await tx.accountTag.findMany({ where: { tagId: tag.id, accountId: { in: validIds } }, select: { accountId: true } });
      const existingIds = new Set(existing.map((item) => item.accountId));
      const missingIds = validIds.filter((accountId) => !existingIds.has(accountId));
      if (missingIds.length) await tx.accountTag.createMany({ data: missingIds.map((accountId) => ({ accountId, tagId: tag.id })) });
    });
  }
  revalidatePath("/accounts");
}

export async function addNotes(data: FormData) {
  const ids = selectedIds(data); const workspace = await getLocalWorkspace(); const note = read(data, "notes");
  if (!note || note.length > 2000) throw new Error("Enter a note up to 2000 characters.");
  await prisma.$transaction(async (tx) => {
    for (const id of ids) {
      const account = await tx.account.findFirst({ where: { id, workspaceId: workspace.id, deletedAt: null }, select: { notes: true } });
      if (!account) continue;
      await tx.account.update({ where: { id }, data: { notes: account.notes ? `${account.notes}\n${note}` : note } });
    }
  });
  revalidatePath("/accounts");
}

export async function renameAccount(data: FormData) {
  const id = Number(read(data, "id")); const displayName = read(data, "displayName").trim(); const notes = read(data, "notes");
  const workspace = await getLocalWorkspace();
  const categoryId = read(data, "categoryId");
  const tags = [...new Set(read(data, "tags").split(",").map((tag) => tag.trim()).filter(Boolean))];
  if (!Number.isSafeInteger(id) || id <= 0 || !displayName || displayName.length > 120) throw new Error("Provide a valid name.");
  if (notes.length > 2000 || tags.some((tag) => tag.length > 40) || tags.length > 30) throw new Error("Notes or tags exceed the allowed length.");
  if (categoryId && !await prisma.category.findFirst({ where: { id: categoryId, workspaceId: workspace.id }, select: { id: true } })) throw new Error("Category not found.");
  await prisma.$transaction(async (tx) => {
    const result = await tx.account.updateMany({ where: { id, workspaceId: workspace.id, deletedAt: null }, data: { displayName, notes: notes.trim() || null, categoryId: categoryId || null } });
    if (!result.count) throw new Error("Account not found.");
    await tx.accountTag.deleteMany({ where: { accountId: id } });
    for (const name of tags) {
      const tag = await tx.tag.upsert({ where: { workspaceId_name: { workspaceId: workspace.id, name } }, update: {}, create: { workspaceId: workspace.id, name } });
      await tx.accountTag.create({ data: { accountId: id, tagId: tag.id } });
    }
    await tx.activityLog.create({ data: { workspaceId: workspace.id, accountId: id, type: "ACCOUNT_UPDATED", message: "Account details and tags updated." } });
  });
  revalidatePath("/accounts");
}

export async function bulkUpdateAccounts(data: FormData) {
  const workspace = await getLocalWorkspace();
  const raw = read(data, "updates");
  let updates: Array<{ id: number; displayName: string; categoryId: string; tags: string; notes: string }>;
  try { updates = JSON.parse(raw) as typeof updates; }
  catch { throw new Error("Invalid bulk edit data."); }
  if (!Array.isArray(updates) || updates.length === 0 || updates.length > 5000) throw new Error("Select between 1 and 5000 accounts.");
  if (updates.some((item) => !item || typeof item.id !== "number")) throw new Error("Invalid account selection.");
  const ids = [...new Set(updates.map((item) => Number(item.id)))];
  if (ids.length !== updates.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error("Invalid account selection.");
  for (const update of updates) {
    if (typeof update.displayName !== "string" || !update.displayName.trim() || update.displayName.trim().length > 120) throw new Error("Each account needs a name up to 120 characters.");
    if (typeof update.notes !== "string" || update.notes.length > 2000) throw new Error("Notes must be 2000 characters or fewer.");
    if (typeof update.categoryId !== "string") throw new Error("Invalid category.");
    if (typeof update.tags !== "string") throw new Error("Invalid tags.");
    const tags = [...new Set(update.tags.split(",").map((tag) => tag.trim()).filter(Boolean))];
    if (tags.length > 30 || tags.some((tag) => tag.length > 40)) throw new Error("Each account can have up to 30 tags, with 40 characters per tag.");
  }
  const categoryIds = [...new Set(updates.map((item) => item.categoryId).filter(Boolean))];
  if (categoryIds.length) {
    const categories = await prisma.category.findMany({ where: { id: { in: categoryIds }, workspaceId: workspace.id }, select: { id: true } });
    if (categories.length !== categoryIds.length) throw new Error("A selected category is no longer available.");
  }
  await prisma.$transaction(async (tx) => {
    for (const item of updates) {
      const result = await tx.account.updateMany({
        where: { id: item.id, workspaceId: workspace.id, deletedAt: null },
        data: { displayName: item.displayName.trim(), categoryId: item.categoryId || null, notes: item.notes.trim() || null },
      });
      if (!result.count) continue;
      await tx.accountTag.deleteMany({ where: { accountId: item.id } });
      const tags = [...new Set(item.tags.split(",").map((tag) => tag.trim()).filter(Boolean))];
      for (const name of tags) {
        const tag = await tx.tag.upsert({ where: { workspaceId_name: { workspaceId: workspace.id, name } }, update: {}, create: { workspaceId: workspace.id, name } });
        await tx.accountTag.create({ data: { accountId: item.id, tagId: tag.id } });
      }
      await tx.activityLog.create({ data: { workspaceId: workspace.id, accountId: item.id, type: "ACCOUNT_UPDATED", message: "Account updated in bulk edit." } });
    }
  });
  revalidatePath("/accounts");
}

export async function bulkTrashAccounts(data: FormData) {
  const ids = selectedIds(data); const workspace = await getLocalWorkspace(); const now = new Date();
  const accounts = await prisma.account.findMany({ where: { id: { in: ids }, workspaceId: workspace.id, deletedAt: null }, select: { id: true, status: true } });
  if (!accounts.length) throw new Error("No active accounts were selected.");
  await prisma.$transaction(async (tx) => {
    for (const account of accounts) {
      await tx.account.update({ where: { id: account.id }, data: { deletedAt: now, statusBeforeTrash: account.status, status: "TRASHED" } });
      await tx.activityLog.create({ data: { workspaceId: workspace.id, accountId: account.id, type: "ACCOUNT_TRASHED", message: "Account moved to trash in bulk." } });
    }
  });
  revalidatePath("/accounts");
}

export async function trashAccount(data: FormData) {
  const id = Number(read(data, "id")); const workspace = await getLocalWorkspace();
  const account = await prisma.account.findFirst({ where: { id, workspaceId: workspace.id, deletedAt: null } });
  if (!account) return;
  await prisma.$transaction(async (tx) => {
    await tx.account.update({ where: { id }, data: { deletedAt: new Date(), statusBeforeTrash: account.status, status: "TRASHED" } });
    await tx.activityLog.create({ data: { workspaceId: workspace.id, accountId: id, type: "ACCOUNT_TRASHED", message: "Account moved to trash." } });
  });
  revalidatePath("/accounts");
}

export async function restoreAccount(data: FormData) {
  const id = Number(read(data, "id")); const workspace = await getLocalWorkspace();
  const account = await prisma.account.findFirst({ where: { id, workspaceId: workspace.id, deletedAt: { not: null } } });
  if (!account) return;
  await prisma.$transaction(async (tx) => {
    await tx.account.update({ where: { id }, data: { deletedAt: null, status: account.statusBeforeTrash ?? "NOT_CONFIGURED", statusBeforeTrash: null } });
    await tx.activityLog.create({ data: { workspaceId: workspace.id, accountId: id, type: "ACCOUNT_RESTORED", message: "Account restored from trash." } });
  });
  revalidatePath("/accounts");
}
