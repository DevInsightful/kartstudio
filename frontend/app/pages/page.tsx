import { connection } from "next/server";
import { getLocalWorkspace, prisma } from "@/lib/prisma";
import PageForm from "./page-form";

export const runtime = "nodejs";

export default async function PagesPage() {
  await connection();
  const workspace = await getLocalWorkspace();
  const accounts = await prisma.account.findMany({
    where: { workspaceId: workspace.id, deletedAt: null, platform: "FACEBOOK" },
    select: { id: true, displayName: true, username: true, status: true },
    orderBy: { displayName: "asc" },
  });
  return <div className="section-page">
    <section className="section-intro">
      <p className="eyebrow">PAGES</p>
      <p>Select active Facebook accounts, import matching Page details, and choose one profile-image folder and one cover-image folder. The helper processes accounts in batches and closes each group of Cent profiles when finished.</p>
    </section>
    <PageForm accounts={accounts.map((account) => ({
      id: account.id,
      label: `${account.displayName}${account.username ? ` · ${account.username}` : ""}`,
      active: account.status === "ACTIVE",
    }))} />
  </div>;
}
