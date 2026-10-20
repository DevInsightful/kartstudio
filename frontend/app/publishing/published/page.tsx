import Link from "next/link";
import { connection } from "next/server";
import { getLocalWorkspace, prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export default async function PublishedPage() {
  await connection();
  const workspace = await getLocalWorkspace();
  const reels = await prisma.reelPost.findMany({
    where: { workspaceId: workspace.id },
    select: { id: true, videoName: true, description: true, status: true, error: true, postedAt: true, createdAt: true, page: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 250,
  });
  return <div className="section-page">
    <section className="section-intro">
      <p className="eyebrow">PUBLISHED</p>
      <p>Review Reel publishing attempts and Facebook confirmation status.</p>
    </section>
    <section className="page-form-panel reels-history-panel">
      <div className="page-form-heading"><div><h3>Reel activity</h3><p>Showing the latest 250 Reel jobs.</p></div><Link className="reels-new-link" href="/publishing/reels">Post Reels</Link></div>
      {!reels.length ? <div className="account-empty-state"><h3>No Reel activity yet</h3><p>Published and attempted Reels will appear here.</p></div> : <div className="reels-history-table-wrap">
        <table className="reels-history-table"><thead><tr><th>Page</th><th>Video</th><th>Status</th><th>Details</th><th>Time</th></tr></thead>
          <tbody>{reels.map((reel) => <tr key={reel.id}><td>{reel.page.name}</td><td>{reel.videoName}</td><td><span className={`reels-history-status status-${reel.status.toLowerCase()}`}>{reel.status}</span></td><td>{reel.error || reel.description}</td><td>{(reel.postedAt ?? reel.createdAt).toLocaleString()}</td></tr>)}</tbody>
        </table>
      </div>}
    </section>
  </div>;
}
