import Link from "next/link";
import { connection } from "next/server";
import { formatAccountCode, getLocalWorkspace, prisma } from "@/lib/prisma";
import AccountsTable from "./table";
import CredentialImport from "./credential-import";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
export const runtime = "nodejs";

export default async function AccountsPage({ searchParams }: Props) {
  await connection();
  const query = await searchParams;
  const search = typeof query.q === "string" ? query.q.trim() : "";
  const showTrash = query.view === "trash";
  const categoryFilter = typeof query.category === "string" ? query.category : "";
  const workspace = await getLocalWorkspace();
  const [accounts, categories, categoryCounts, activeCount, trashCount] = await Promise.all([
    prisma.account.findMany({
      where: { workspaceId: workspace.id, deletedAt: showTrash ? { not: null } : null,
        ...(!showTrash && categoryFilter ? { categoryId: categoryFilter === "uncategorized" ? null : categoryFilter } : {}),
        ...(search ? { OR: [{ displayName: { contains: search } }, { username: { contains: search } },
          ...(search.toUpperCase().startsWith("ACC-") && /^ACC-\d+$/i.test(search) ? [{ id: Number(search.slice(4)) }] : [])] } : {}) },
      include: { category: true, credentials: { select: { id: true } }, tags: { include: { tag: true } } }, orderBy: { createdAt: "desc" },
    }),
    prisma.category.findMany({ where: { workspaceId: workspace.id }, orderBy: { name: "asc" } }),
    prisma.account.groupBy({ by: ["categoryId"], where: { workspaceId: workspace.id, deletedAt: null }, _count: { _all: true } }),
    prisma.account.count({ where: { workspaceId: workspace.id, deletedAt: null } }),
    prisma.account.count({ where: { workspaceId: workspace.id, deletedAt: { not: null } } }),
  ]);
  const folderCounts = new Map(categoryCounts.map((item) => [item.categoryId ?? "uncategorized", item._count._all]));
  const selectedCategory = categories.find((item) => item.id === categoryFilter);
  const listTitle = showTrash ? "Trash" : selectedCategory?.name ?? (categoryFilter === "uncategorized" ? "Uncategorized" : "All accounts");
  const notice = typeof query.imported === "string" ? `Imported ${query.imported} account(s); skipped ${query.skipped ?? "0"} duplicate or invalid row(s).` : undefined;
  const importErrors: Record<string, string> = {
    "local-only": "Credential import is available only from this local app.",
    "choose-file": "Choose a CSV, TXT, or XLSX file to import.",
    "file-size": "The selected file is larger than the 10 MB limit.",
    "file-type": "Supported files are CSV, TXT, and XLSX.",
    "file-read": "Could not read this file. Use a CSV/TXT with mail,password columns or the downloaded XLSX template.",
    "row-limit": "The selected file has more than 5,000 rows.",
    duplicate: "An account with one of these email addresses already exists. Remove duplicates from the file and retry.",
    schema: "The app database client is out of date. Stop and restart the development server, then retry.",
    database: "Could not save accounts to the local database. Check the app terminal for a database error.",
    server: "The import request failed. Restart the app and retry; check its terminal output if it continues.",
  };
  const importError = typeof query.importError === "string" ? importErrors[query.importError] : undefined;
  const importDbCode = typeof query.dbCode === "string" && /^[A-Za-z0-9_-]{1,48}$/.test(query.dbCode) ? query.dbCode : undefined;

  return <div className="accounts-page">
    <section className="accounts-intro"><div><p className="eyebrow">LOCAL ACCOUNT STORE</p><h2>Accounts</h2><p>Import a mail and password list, then organize selected accounts with categories, tags, and notes.</p></div>
      <div className="account-counts"><span><strong>{activeCount}</strong> active</span><span><strong>{trashCount}</strong> in trash</span></div></section>
    {notice && <p className="account-alert success-alert" role="status">{notice}</p>}
    {importError && <p className="account-alert error-alert" role="alert">{importError}{query.importError === "database" && importDbCode ? ` (database code: ${importDbCode})` : ""}</p>}
    {!showTrash && <CredentialImport />}
    <section className="account-list-panel" aria-labelledby="account-list-title">
      {!showTrash && <nav className="account-folders" aria-label="Account category folders"><Link className={`account-folder${!categoryFilter ? " active" : ""}`} href="/accounts"><span aria-hidden="true">▰</span><span>All accounts</span><b>{activeCount}</b></Link>{categories.map((item) => <Link className={`account-folder${categoryFilter === item.id ? " active" : ""}`} href={`/accounts?category=${encodeURIComponent(item.id)}`} key={item.id}><span aria-hidden="true">▰</span><span>{item.name}</span><b>{folderCounts.get(item.id) ?? 0}</b></Link>)}{(folderCounts.get("uncategorized") ?? 0) > 0 && <Link className={`account-folder${categoryFilter === "uncategorized" ? " active" : ""}`} href="/accounts?category=uncategorized"><span aria-hidden="true">▰</span><span>Uncategorized</span><b>{folderCounts.get("uncategorized")}</b></Link>}</nav>}
      <div className="account-list-toolbar"><div><h3 id="account-list-title">{listTitle}</h3><p>Select rows to bulk edit, move to Trash, assign a category, add tags, or add notes.</p></div>
        <div className="account-toolbar-actions"><Link className={`view-link${!showTrash ? " active" : ""}`} href="/accounts">Active <span>{activeCount}</span></Link><Link className={`view-link${showTrash ? " active" : ""}`} href="/accounts?view=trash">Trash <span>{trashCount}</span></Link></div></div>
      <form action="/accounts" className="account-search-form">{showTrash && <input type="hidden" name="view" value="trash" />}{!showTrash && categoryFilter && <input type="hidden" name="category" value={categoryFilter} />}<label className="search-field"><span aria-hidden="true">⌕</span><input type="search" name="q" defaultValue={search} placeholder="Search accounts…" aria-label="Search accounts" /><button type="submit">Search</button></label></form>
      {accounts.length === 0 ? <div className="account-empty-state"><span className="empty-state-mark">+</span><h3>{search ? "No matching accounts" : showTrash ? "Trash is empty" : categoryFilter ? "This folder is empty" : "No accounts imported yet"}</h3><p>{search ? "Try another email or account ID." : showTrash ? "Trashed accounts can be restored here." : categoryFilter ? "Assign accounts to this category to move them into this folder." : "Choose your CSV, TXT, or Excel file above. It only needs mail and password columns."}</p></div> :
        <AccountsTable accounts={accounts.map((a) => ({ id: a.id, code: formatAccountCode(a.id), displayName: a.displayName, username: a.username, category: a.category?.name ?? null, categoryId: a.categoryId, tags: a.tags.map((x) => x.tag.name), notes: a.notes, status: a.status, hasCredentials: Boolean(a.credentials) }))} categories={categories.map((c) => ({ id: c.id, name: c.name }))} trash={showTrash} />}
    </section>
  </div>;
}
