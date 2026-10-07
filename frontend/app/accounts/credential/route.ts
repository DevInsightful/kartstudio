import { NextResponse } from "next/server";
import { getLocalWorkspace, prisma } from "@/lib/prisma";

export const runtime = "nodejs";
const privateHeaders = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache" };

export async function POST(request: Request) {
  const hostHeader = request.headers.get("host");
  const host = hostHeader?.split(":")[0]?.toLowerCase();
  const origin = request.headers.get("origin");
  if (!hostHeader || !host || !["127.0.0.1", "localhost", "[::1]"].includes(host) || !origin || new URL(origin).host.toLowerCase() !== hostHeader.toLowerCase()) {
    return NextResponse.json({ error: "Password reveal is available only from this local app." }, { status: 403, headers: privateHeaders });
  }
  try {
    const body = await request.json() as { id?: unknown };
    const id = Number(body.id);
    if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid account." }, { status: 400, headers: privateHeaders });
    const workspace = await getLocalWorkspace();
    const account = await prisma.account.findFirst({ where: { id, workspaceId: workspace.id, deletedAt: null }, include: { credentials: true } });
    if (!account?.credentials) return NextResponse.json({ error: "No imported password is available for this account." }, { status: 404, headers: privateHeaders });
    return NextResponse.json({ password: account.credentials.password }, { headers: privateHeaders });
  } catch {
    return NextResponse.json({ error: "Could not read this account password from the local database." }, { status: 500, headers: privateHeaders });
  }
}
