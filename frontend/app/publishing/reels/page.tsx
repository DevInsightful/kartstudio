import { connection } from "next/server";
import { getLocalWorkspace, prisma } from "@/lib/prisma";
import ReelsForm from "./reels-form";

export const runtime = "nodejs";

export default async function ReelsPage() {
  await connection();
  const workspace = await getLocalWorkspace();
  const pages = await prisma.page.findMany({
    where: {
      workspaceId: workspace.id,
      status: "ACTIVE",
      account: { is: { status: "ACTIVE", deletedAt: null, platform: "FACEBOOK" } },
    },
    select: {
      id: true,
      name: true,
      account: { select: { id: true, displayName: true, username: true } },
    },
    orderBy: [{ name: "asc" }],
  });

  return <div className="section-page">
    <section className="section-intro">
      <p className="eyebrow">PUBLISHING · REELS</p>
      <p>Select active Facebook Pages, choose a folder with one video for each Page, and set how many Page jobs to run at a time. Videos and descriptions map in the order shown below.</p>
    </section>
    <ReelsForm pages={pages.filter((page) => page.account).map((page) => ({
      id: page.id,
      name: page.name,
      accountId: page.account!.id,
      accountLabel: `${page.account!.displayName}${page.account!.username ? ` · ${page.account!.username}` : ""}`,
    }))} />
  </div>;
}
