import "server-only";

import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@/generated/prisma/client";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";

const dataDirectory = path.join(process.cwd(), "data");
mkdirSync(dataDirectory, { recursive: true });

const databaseUrl = "file:./data/kartstudio.db";
const adapter = new PrismaBetterSqlite3({ url: databaseUrl });
// Bump this cache key when the Prisma schema changes so Next.js hot reload
// cannot keep serving a client instance generated before a new model existed.
const globalForPrisma = globalThis as unknown as { prismaWithUsers?: PrismaClient };

export const prisma = globalForPrisma.prismaWithUsers ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") globalForPrisma.prismaWithUsers = prisma;

export async function getLocalWorkspace() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const workspace = await prisma.workspace.findUnique({ where: { id: user.workspaceId } });
  if (!workspace) throw new Error("This user workspace is unavailable.");
  return workspace;
}

export function formatAccountCode(id: number) {
  return `ACC-${id.toString().padStart(6, "0")}`;
}
