import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { getLocalWorkspace, prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 5000;
function returnToAccounts(request: Request, params: Record<string, string>) {
  const destination = new URL("/accounts", request.url);
  for (const [key, value] of Object.entries(params)) destination.searchParams.set(key, value);
  return NextResponse.redirect(destination, 303);
}

type CredentialRow = { mail: string; password: string };
function parseDelimitedLine(line: string, separator: string): string[] {
  const cells: string[] = [];
  let value = ""; let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') { if (quoted && line[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (char === separator && !quoted) { cells.push(value.trim()); value = ""; }
    else value += char;
  }
  cells.push(value.trim());
  return cells;
}
function mapRows(rows: string[][]): CredentialRow[] {
  const nonempty = rows.filter((row) => row.some((cell) => cell.trim()));
  if (!nonempty.length) return [];
  const first = nonempty[0].map((cell) => cell.trim().toLowerCase());
  const mailIndex = first.findIndex((v) => ["mail", "email", "e-mail", "username"].includes(v));
  const passwordIndex = first.findIndex((v) => ["password", "pass", "pwd"].includes(v));
  const start = mailIndex >= 0 && passwordIndex >= 0 ? 1 : 0;
  const mi = start ? mailIndex : 0; const pi = start ? passwordIndex : 1;
  return nonempty.slice(start).map((row) => ({ mail: (row[mi] ?? "").trim(), password: (row[pi] ?? "").trim() }));
}
async function parseFile(file: File): Promise<CredentialRow[]> {
  const bytes = Buffer.from(await file.arrayBuffer());
  const extension = file.name.toLowerCase().split(".").pop();
  if (extension === "xlsx") {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as never);
    const sheet = workbook.worksheets[0];
    if (!sheet) return [];
    const values: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => values.push(row.values.slice(1).map((cell) => cell == null ? "" : String(cell))));
    return mapRows(values);
  }
  const text = bytes.toString("utf8").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const separator = extension === "txt" ? (lines[0]?.includes("\t") ? "\t" : lines[0]?.includes("|") ? "|" : ",") : ",";
  return mapRows(lines.map((line) => parseDelimitedLine(line, separator)));
}

export async function POST(request: Request) {
  try {
  const host = request.headers.get("host")?.split(":")[0]?.toLowerCase();
  const origin = request.headers.get("origin");
  if (!host || !["127.0.0.1", "localhost", "[::1]"].includes(host) || !origin || new URL(origin).host.toLowerCase() !== request.headers.get("host")?.toLowerCase()) {
    return returnToAccounts(request, { importError: "local-only" });
  }
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return returnToAccounts(request, { importError: "choose-file" });
  if (file.size > MAX_BYTES) return returnToAccounts(request, { importError: "file-size" });
  if (!/\.(csv|txt|xlsx)$/i.test(file.name)) return returnToAccounts(request, { importError: "file-type" });
  let rows: CredentialRow[];
  try { rows = await parseFile(file); }
  catch { return returnToAccounts(request, { importError: "file-read" }); }
  if (rows.length > MAX_ROWS) return returnToAccounts(request, { importError: "row-limit" });
  const unique = new Map<string, string>();
  for (const row of rows) if (row.mail && row.password && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.mail)) unique.set(row.mail.toLowerCase(), row.password);
  const workspace = await getLocalWorkspace();
  const already = await prisma.account.findMany({ where: { workspaceId: workspace.id, username: { in: [...unique.keys()] } }, select: { username: true } });
  const duplicates = new Set(already.map((account) => account.username?.toLowerCase()).filter((v): v is string => Boolean(v)));
  const candidates = [...unique.entries()].filter(([mail]) => !duplicates.has(mail));
  if (candidates.length) {
    try {
      await prisma.$transaction(async (tx) => {
        for (let i = 0; i < candidates.length; i++) {
          const [mail] = candidates[i];
          const account = await tx.account.create({ data: { workspaceId: workspace.id, displayName: mail, username: mail } });
          await tx.credentialRecord.create({ data: { accountId: account.id, username: mail, password: candidates[i][1] } });
          await tx.activityLog.create({ data: { workspaceId: workspace.id, accountId: account.id, type: "ACCOUNT_IMPORTED", message: "Account imported from local credential file." } });
        }
      });
    } catch (error) {
      const errorCode = error && typeof error === "object" && "code" in error
        ? String(error.code)
        : error && typeof error === "object" && "name" in error ? String(error.name) : "unknown";
      console.error(`[account-import] Database write failed (${errorCode}).`);
      const safeCode = /^[A-Za-z0-9_-]{1,48}$/.test(errorCode) ? errorCode : "unknown";
      return returnToAccounts(request, { importError: errorCode === "P2002" ? "duplicate" : errorCode === "P2022" ? "schema" : "database", dbCode: safeCode });
    }
  }
  const skipped = rows.length - candidates.length;
  return returnToAccounts(request, { imported: String(candidates.length), skipped: String(skipped) });
  } catch (error) {
    console.error("[account-import] Request failed:", error instanceof Error ? error.name : "UnknownError");
    return returnToAccounts(request, { importError: "server" });
  }
}
