import { connection } from "next/server";
import { getLocalWorkspace, prisma } from "@/lib/prisma";
import PageForm from "./page-form";

export const runtime = "nodejs";

export default async function PagesPage() {
  await connection();
  const workspace = await getLocalWorkspace();
  const accounts = await prisma.account.findMany({
    where: { workspaceId: workspace.id, deletedAt: null, platform: "FACEBOOK", status: "ACTIVE" },
    select: {
      id: true,
      displayName: true,
      username: true,
      status: true,
      pages: {
        where: { status: "ACTIVE" },
        select: { id: true, name: true, followerCount: true },
        orderBy: { name: "asc" },
      },
    },
    orderBy: { displayName: "asc" },
  });
  return <div className="section-page">
    <section className="section-intro">
      <p className="eyebrow">PAGES</p>
      <p>Active Facebook accounts are listed here. Refresh an account to load its Facebook Pages and follower counts; Pages created through KartStudio are added to that account automatically.</p>
    </section>
    <PageForm accounts={accounts.map((account) => ({
      id: account.id,
      label: `${account.displayName}${account.username ? ` · ${account.username}` : ""}`,
      active: account.status === "ACTIVE",
      pages: account.pages,
    }))} />
  </div>;
}
