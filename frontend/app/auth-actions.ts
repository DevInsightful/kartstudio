"use server";

import { redirect } from "next/navigation";
import { createAuthSession, destroyAuthSession, getCurrentUser, hashPassword, verifyPassword } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

function value(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

export async function loginAction(formData: FormData) {
  const identifier = value(formData, "identifier").toLocaleLowerCase();
  const password = String(formData.get("password") ?? "");
  const user = await prisma.user.findFirst({ where: { OR: [{ username: identifier }, { email: identifier }] } });
  if (!user || !await verifyPassword(password, user.passwordHash)) redirect("/login?error=invalid");
  await createAuthSession(user.id);
  redirect("/");
}

export async function setupAdminAction(formData: FormData) {
  const username = value(formData, "username").toLocaleLowerCase();
  const email = value(formData, "email").toLocaleLowerCase() || null;
  const password = String(formData.get("password") ?? "");
  if (!/^[a-z0-9_.-]{3,40}$/.test(username)) redirect("/setup?error=username");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) redirect("/setup?error=email");
  let userId = "";
  try {
    const passwordHash = await hashPassword(password);
    await prisma.$transaction(async (tx) => {
      if (await tx.user.count()) throw new Error("Setup is already complete.");
      const workspace = await tx.workspace.upsert({
        where: { id: "local-workspace" },
        update: { name: `${username}'s Workspace` },
        create: { id: "local-workspace", name: `${username}'s Workspace` },
      });
      const user = await tx.user.create({ data: { username, email, passwordHash, role: "ADMIN", workspaceId: workspace.id } });
      userId = user.id;
    });
  } catch {
    redirect("/setup?error=duplicate");
  }
  await createAuthSession(userId);
  redirect("/");
}

export async function logoutAction() {
  await destroyAuthSession();
  redirect("/login");
}

export async function changeOwnPasswordAction(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const currentPassword = String(formData.get("currentPassword") ?? "");
  const nextPassword = String(formData.get("newPassword") ?? "");
  const record = await prisma.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } });
  if (!record || !await verifyPassword(currentPassword, record.passwordHash)) redirect("/settings?error=current-password");
  let passwordHash: string;
  try { passwordHash = await hashPassword(nextPassword); }
  catch { redirect("/settings?error=new-password"); }
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
  await prisma.authSession.deleteMany({ where: { userId: user.id } });
  await createAuthSession(user.id);
  redirect("/settings?changed=1");
}
