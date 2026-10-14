export const runtime = "nodejs";

export async function GET() {
  const csv = [
    "name,bio",
    'Luxe Living,"Premium furniture and thoughtful design for your home."',
    'Home Style,"Modern interiors, decor, and ideas for comfortable living."',
  ].join("\r\n") + "\r\n";
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="kartstudio-page-details-example.csv"',
      "Cache-Control": "no-store",
    },
  });
}
