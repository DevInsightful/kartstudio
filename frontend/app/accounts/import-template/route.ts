import { NextResponse } from "next/server";
import ExcelJS from "exceljs";

export const runtime = "nodejs";
export async function GET(request: Request) {
  const format = new URL(request.url).searchParams.get("format")?.toLowerCase();
  if (format === "csv" || format === "txt") {
    const separator = format === "csv" ? "," : "\t";
    const body = `mail${separator}password\r\nname@example.com${separator}replace-with-password\r\n`;
    return new Response(body, { headers: { "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="kartstudio-account-example.${format}"`, "Cache-Control": "no-store" } });
  }
  if (format === "xlsx") {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Accounts");
    sheet.addRow(["mail", "password"]);
    sheet.addRow(["name@example.com", "replace-with-password"]);
    const buffer = await workbook.xlsx.writeBuffer();
    return new Response(new Uint8Array(buffer), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": "attachment; filename=\"kartstudio-account-example.xlsx\"", "Cache-Control": "no-store" } });
  }
  return NextResponse.json({ error: "Select csv, txt, or xlsx." }, { status: 400 });
}
