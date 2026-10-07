import "server-only";

import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@/generated/prisma/client";
import { mkdirSync } from "node:fs";
import path from "node:path";

const dataDirectory = path.join(process.cwd(), "data");
mkdirSync(dataDirectory, { recursive: true });

const databaseUrl = "file:./data/kartstudio.db";
const adapter = new PrismaBetterSqlite3({ url: databaseUrl });
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export async function getLocalWorkspace() {
  return prisma.workspace.upsert({
    where: { id: "local-workspace" },
    update: {},
    create: { id: "local-workspace", name: "Local Workspace" },
  });
}

export function formatAccountCode(id: number) {
  return `ACC-${id.toString().padStart(6, "0")}`;
}
