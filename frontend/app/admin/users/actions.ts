"use server";

import { redirect } from "next/navigation";
import { hashPassword, requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

function field(formData: FormData, name: string) { return String(formData.get(name) ?? "").trim(); }

export async function createUserAction(formData: FormData) {
  await requireAdmin();
  const username = field(formData, "username").toLocaleLowerCase();
  const email = field(formData, "email").toLocaleLowerCase() || null;
  const password = String(formData.get("password") ?? "");
  if (!/^[a-z0-9_.-]{3,40}$/.test(username)) redirect("/admin/users?error=username");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) redirect("/admin/users?error=email");
  try {
    const passwordHash = await hashPassword(password);
    await prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({ data: { name: `${username}'s Workspace` } });
      await tx.user.create({ data: { username, email, passwordHash, role: "USER", workspaceId: workspace.id } });
    });
  } catch { redirect("/admin/users?error=duplicate"); }
  redirect("/admin/users?created=1");
}

export async function resetUserPasswordAction(formData: FormData) {
  await requireAdmin();
  const userId = field(formData, "userId");
  const password = String(formData.get("password") ?? "");
  let passwordHash: string;
  try { passwordHash = await hashPassword(password); }
  catch { redirect("/admin/users?error=password"); }
  const result = await prisma.user.updateMany({ where: { id: userId }, data: { passwordHash } });
  if (!result.count) redirect("/admin/users?error=missing");
  await prisma.authSession.deleteMany({ where: { userId } });
  redirect("/admin/users?reset=1");
}
