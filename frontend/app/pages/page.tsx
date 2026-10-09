import { connection } from "next/server";
import { getLocalWorkspace, prisma } from "@/lib/prisma";
import PageForm from "./page-form";

export const runtime = "nodejs";

export default async function PagesPage() {
  await connection();
  const workspace = await getLocalWorkspace();
  const accounts = await prisma.account.findMany({
    where: { workspaceId: workspace.id, deletedAt: null, status: "ACTIVE", platform: "FACEBOOK" },
    select: { id: true, displayName: true, username: true },
    orderBy: { displayName: "asc" },
  });
  return <div className="section-page">
    <section className="section-intro">
      <p className="eyebrow">PAGES</p>
      <p>Prepare one Facebook Page at a time using an active account profile. Review the details and submit the Page yourself in Cent.</p>
    </section>
    <PageForm accounts={accounts.map((account) => ({
      id: account.id,
      label: `${account.displayName}${account.username ? ` · ${account.username}` : ""}`,
    }))} />
  </div>;
}
