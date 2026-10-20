import Link from "next/link";
import { connection } from "next/server";
import { getLocalWorkspace, prisma } from "@/lib/prisma";
import ProfessionalDashboardForm from "../professional-dashboard-form";

export const runtime = "nodejs";

export default async function ProfessionalDashboardUploadPage() {
  await connection();
  const workspace = await getLocalWorkspace();
  const pages = await prisma.page.findMany({
    where: { workspaceId: workspace.id, status: "ACTIVE", account: { is: { platform: "FACEBOOK", status: "ACTIVE", deletedAt: null } } },
    select: { id: true, name: true, account: { select: { id: true, displayName: true, username: true } } },
    orderBy: [{ accountId: "asc" }, { name: "asc" }],
  });

  return <div className="section-page">
    <section className="section-intro">
      <p className="eyebrow">UPLOAD · PROFESSIONAL DASHBOARD</p>
      <p>Select Facebook Pages under their owning accounts. Choose one video for each selected Page, or select one Page and upload a batch of Reels to it.</p>
      <Link className="professional-upload-back" href="/publishing/upload">← Upload destinations</Link>
    </section>
    <ProfessionalDashboardForm pages={pages.filter((page) => page.account).map((page) => ({
      id: page.id,
      name: page.name,
      accountId: page.account!.id,
      accountLabel: `${page.account!.displayName}${page.account!.username ? ` · ${page.account!.username}` : ""}`,
    }))} />
  </div>;
}
