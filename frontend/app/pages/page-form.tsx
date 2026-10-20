"use client";

import { Fragment, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { runPageCreationGroup, syncFacebookPageInventory } from "./actions";
import { FACEBOOK_PAGE_CATEGORIES } from "@/lib/facebook-page-categories";
import { parsePageDetailsCsv } from "@/lib/page-details-csv";

type AccountOption = {
  id: number;
  label: string;
  active: boolean;
  pages: { id: string; name: string; followerCount: number | null }[];
};
type FolderFile = File & { webkitRelativePath?: string };
const PAGE_SIZES = [10, 25, 50, 100];
const JOB_OPTIONS = [1, 2, 3, 4, 6, 8, 12, 16, 20];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|gif|bmp|tiff?|heic|heif|avif)$/i;

function sortFolderImages(files: FileList | File[]) {
  return Array.from(files).filter((file) => IMAGE_EXTENSIONS.test(file.name)).sort((a, b) => {
    const aPath = (a as FolderFile).webkitRelativePath || a.name;
    const bPath = (b as FolderFile).webkitRelativePath || b.name;
    return aPath.localeCompare(bPath, undefined, { numeric: true, sensitivity: "base" });
  });
}

async function findDuplicateImages(files: File[]) {
  const seen = new Map<string, string>();
  const duplicates: string[] = [];
  for (const file of files) {
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const previous = seen.get(key);
    if (previous) duplicates.push(`${file.name} duplicates ${previous}`);
    else seen.set(key, file.name);
  }
  return duplicates;
}

export default function PageForm({ accounts }: { accounts: AccountOption[] }) {
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [jobsAtOnce, setJobsAtOnce] = useState(2);
  const [category, setCategory] = useState("");
  const [stopBeforeCreate, setStopBeforeCreate] = useState(false);
  const [detailsCsv, setDetailsCsv] = useState<File | null>(null);
  const [profileImages, setProfileImages] = useState<File[]>([]);
  const [coverImages, setCoverImages] = useState<File[]>([]);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);
  const [progress, setProgress] = useState("");
  const [syncingAccountId, setSyncingAccountId] = useState<number | null>(null);
  const [expandedAccountIds, setExpandedAccountIds] = useState<Set<number>>(() => new Set());
  const [syncMessage, setSyncMessage] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const profileFolderRef = useRef<HTMLInputElement>(null);
  const coverFolderRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    profileFolderRef.current?.setAttribute("webkitdirectory", "");
    profileFolderRef.current?.setAttribute("directory", "");
    coverFolderRef.current?.setAttribute("webkitdirectory", "");
    coverFolderRef.current?.setAttribute("directory", "");
  }, []);

  const pageCount = Math.max(1, Math.ceil(accounts.length / pageSize));
  const visibleAccounts = accounts.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedAccounts = accounts.filter((account) => selectedSet.has(account.id));
  const selectedVisible = visibleAccounts.filter((account) => account.active && selectedSet.has(account.id));
  const activeVisible = visibleAccounts.filter((account) => account.active);

  function toggleAccount(id: number) {
    setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  function toggleAccountPages(id: number) {
    setExpandedAccountIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleVisibleAccounts() {
    const allVisibleSelected = activeVisible.length > 0 && activeVisible.every((account) => selectedSet.has(account.id));
    setSelectedIds((current) => allVisibleSelected
      ? current.filter((id) => !activeVisible.some((account) => account.id === id))
      : [...new Set([...current, ...activeVisible.map((account) => account.id)])]);
  }

  async function refreshAccountPages(accountId: number) {
    setSyncingAccountId(accountId);
    setSyncMessage("");
    try {
      const result = await syncFacebookPageInventory(accountId);
      setSyncMessage(result.count ? `Loaded ${result.count} Page${result.count === 1 ? "" : "s"} from Facebook.` : "Facebook did not list any Pages for this account.");
      router.refresh();
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : "Could not load Pages from Facebook.");
    } finally {
      setSyncingAccountId(null);
    }
  }

  function startRun() {
    setMessage("");
    setIsError(false);
    setProgress("");
    const selected = accounts.filter((account) => selectedSet.has(account.id));
    if (!selected.length) { setMessage("Select at least one active Facebook account."); setIsError(true); return; }
    if (selected.length > 500) { setMessage("Select no more than 500 accounts in one run."); setIsError(true); return; }
    if (!category) { setMessage("Choose a Page category."); setIsError(true); return; }
    if (!detailsCsv) { setMessage("Choose the CSV with one name and bio for every selected account."); setIsError(true); return; }
    if (profileImages.length !== selected.length || coverImages.length !== selected.length) {
      setMessage(`Select folders with exactly ${selected.length} profile images and ${selected.length} cover images.`);
      setIsError(true);
      return;
    }
    if ([...profileImages, ...coverImages].some((file) => file.size <= 0 || file.size > MAX_IMAGE_SIZE)) {
      setMessage("Every profile and cover image must be between 1 byte and 10 MB.");
      setIsError(true);
      return;
    }

    const completedIds: number[] = [];
    const failed: string[] = [];
    const openForReviewIds: number[] = [];
    const csvFile = detailsCsv;
    startTransition(async () => {
      let details: ReturnType<typeof parsePageDetailsCsv>;
      try {
        details = parsePageDetailsCsv(await csvFile.text());
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Could not read the names and bios CSV.");
        setIsError(true);
        return;
      }
      if (details.length !== selected.length) {
        setMessage(`The CSV has ${details.length} name/bio rows, but ${selected.length} accounts are selected. Make the counts match.`);
        setIsError(true);
        return;
      }
      const invalidRow = details.findIndex((detail) => !detail.name || detail.name.length > 75 || !detail.bio || detail.bio.length > 500);
      if (invalidRow >= 0) {
        setMessage(`CSV row ${invalidRow + 2} needs a Page name (1–75 characters) and bio (1–500 characters).`);
        setIsError(true);
        return;
      }
      try {
        const duplicates = await findDuplicateImages([...profileImages, ...coverImages]);
        if (duplicates.length) {
          setMessage(`Remove duplicate image files before starting:\n${duplicates.join("\n")}`);
          setIsError(true);
          return;
        }
      } catch {
        setMessage("Could not inspect image files for duplicates. Try selecting the folders again.");
        setIsError(true);
        return;
      }
      for (let start = 0; start < selected.length; start += jobsAtOnce) {
        const group = selected.slice(start, start + jobsAtOnce);
        setProgress(`Working on accounts ${start + 1}–${start + group.length} of ${selected.length}…`);
        const formData = new FormData();
        formData.set("allAccountIds", JSON.stringify(selected.map((account) => account.id)));
        formData.set("groupAccountIds", JSON.stringify(group.map((account) => account.id)));
        formData.set("groupStart", String(start));
        formData.set("category", category);
        formData.set("stopBeforeCreate", String(stopBeforeCreate));
        formData.set("detailsCsv", csvFile);
        for (const file of profileImages.slice(start, start + group.length)) formData.append("profileImages", file, file.name);
        for (const file of coverImages.slice(start, start + group.length)) formData.append("coverImages", file, file.name);
        try {
          const result = await runPageCreationGroup(formData);
          completedIds.push(...result.completedIds);
          failed.push(...result.failed);
          openForReviewIds.push(...result.openForReviewIds);
        } catch (error) {
          failed.push(...group.map((account) => `ACC-${String(account.id).padStart(6, "0")}: ${error instanceof Error ? error.message : "This job group failed."}`));
        }
      }
      setProgress("");
      const completedNames = selected.filter((account) => completedIds.includes(account.id)).map((account) => account.label);
      const openForReviewNames = selected.filter((account) => openForReviewIds.includes(account.id)).map((account) => account.label);
      const summary = `${completedIds.length} of ${selected.length} Pages completed. ${openForReviewNames.length ? "Unconfirmed Cent profiles remain open for review." : "Cent profiles were closed after each job group."}`;
      setMessage([summary, ...completedNames.map((label) => `✓ ${label}`), ...failed.map((failure) => `• ${failure}`),
        ...openForReviewNames.map((label) => `Cent profile kept open for review: ${label}`)].join("\n"));
      setIsError(failed.length > 0 || completedIds.length !== selected.length);
    });
  }

  return <section className="page-form-panel page-batch-panel" aria-labelledby="page-form-title">
    <div className="page-form-heading">
      <div><p className="eyebrow">PAGES · BATCH</p><h3 id="page-form-title">Create Pages for selected accounts</h3>
        <p>Select active accounts across the paginated list. Jobs run in groups of the selected size; each group opens, completes, and closes its Cent profiles before the next group.</p>
      </div>
    </div>

    {accounts.length === 0 ? <p className="account-alert error-alert" role="status">No active Facebook accounts are available. Import accounts first, then verify the accounts you want to use are active.</p> : <>
      <div className="page-account-toolbar">
        <strong>{selectedIds.length} selected</strong>
        <label>Rows per page
          <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setCurrentPage(1); }} disabled={isPending}>
            {PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
      </div>
      <div className="page-account-list" role="region" aria-label="Facebook accounts">
        <table>
          <thead><tr><th><input type="checkbox" aria-label="Select active accounts on this page" checked={activeVisible.length > 0 && selectedVisible.length === activeVisible.length} onChange={toggleVisibleAccounts} disabled={isPending || !activeVisible.length} /></th><th>Account ID</th><th>Account</th><th>Status</th><th>Pages</th></tr></thead>
          <tbody>{visibleAccounts.map((account) => {
            const expanded = expandedAccountIds.has(account.id);
            return <Fragment key={account.id}>
              <tr>
                <td><input type="checkbox" aria-label={`Select ${account.label}`} checked={selectedSet.has(account.id)} onChange={() => toggleAccount(account.id)} disabled={isPending || !account.active} /></td>
                <td><strong>ACC-{String(account.id).padStart(6, "0")}</strong></td>
                <td>{account.label}</td><td><span className="page-account-active">Active</span></td>
                <td><div className="page-account-pages-control"><span>{account.pages.length} {account.pages.length === 1 ? "Page" : "Pages"}</span><button type="button" className="page-account-expand" aria-expanded={expanded} aria-label={`${expanded ? "Hide" : "Show"} Pages for ACC-${String(account.id).padStart(6, "0")}`} onClick={() => toggleAccountPages(account.id)}>{expanded ? "Hide pages" : "Show pages"}</button></div></td>
              </tr>
              {expanded && <tr key={`${account.id}-pages`} className="page-account-details-row"><td colSpan={5}>
                <div className="page-owned-header"><strong>Pages for ACC-{String(account.id).padStart(6, "0")}</strong><button type="button" className="page-inventory-refresh" onClick={() => refreshAccountPages(account.id)} disabled={isPending || syncingAccountId !== null}>{syncingAccountId === account.id ? "Loading…" : "Refresh from Facebook"}</button></div>
                {account.pages.length ? <table className="page-owned-table"><thead><tr><th>Page name</th><th>Page ID</th><th>Followers</th></tr></thead><tbody>{account.pages.map((page) => <tr key={page.id}>
                  <td>{page.name}</td><td>{page.id}</td><td>{page.followerCount === null ? "Unavailable" : page.followerCount.toLocaleString()}</td>
                </tr>)}</tbody></table> : <span className="page-owned-empty">Refresh to load this account’s Pages</span>}
              </td></tr>}
            </Fragment>;
          })}</tbody>
        </table>
      </div>
      {syncMessage && <p className="account-alert" role="status">{syncMessage}</p>}
      <div className="page-pagination">
        <span>Page {currentPage} of {pageCount} · {accounts.length} accounts</span>
        <div><button type="button" onClick={() => setCurrentPage((page) => Math.max(1, page - 1))} disabled={isPending || currentPage <= 1}>Previous</button><button type="button" onClick={() => setCurrentPage((page) => Math.min(pageCount, page + 1))} disabled={isPending || currentPage >= pageCount}>Next</button></div>
      </div>

      <label className="modal-field">Jobs at once
        <select value={jobsAtOnce} onChange={(event) => setJobsAtOnce(Number(event.target.value))} disabled={isPending}>
          {JOB_OPTIONS.map((count) => <option key={count} value={count}>{count} at a time</option>)}
        </select>
        <small>Each group runs together, then its Cent profiles close before the next group starts.</small>
      </label>
      <label className="modal-field">Page category
        <select value={category} onChange={(event) => setCategory(event.target.value)} disabled={isPending}>
          <option value="">Choose a category</option>
          {FACEBOOK_PAGE_CATEGORIES.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <label className="modal-field">Names and bios CSV
        <input type="file" accept=".csv,text/csv" onChange={(event) => setDetailsCsv(event.target.files?.[0] ?? null)} disabled={isPending} />
        <small>{detailsCsv ? detailsCsv.name : "One data row for each selected account, in account-list order."} <a href="/pages/import-template" download>Download example CSV</a></small>
      </label>
      <div className="page-import-example"><strong>CSV format · header is not counted</strong><pre>{`name,bio\nLuxe Living,Premium furniture for your home.\nHome Style,Modern interiors and decor.`}</pre><small>Every row needs a name and bio. Row 1 maps to selected account 1, row 2 to selected account 2, and so on.</small></div>
      <label className="modal-field">Profile images folder
        <input ref={profileFolderRef} type="file" multiple accept="image/*,.heic,.heif,.avif" onChange={(event) => setProfileImages(sortFolderImages(event.target.files ?? []))} disabled={isPending} />
        <small>{profileImages.length} image files · ordered by filename to match the selected accounts.</small>
      </label>
      <label className="modal-field">Cover images folder
        <input ref={coverFolderRef} type="file" multiple accept="image/*,.heic,.heif,.avif" onChange={(event) => setCoverImages(sortFolderImages(event.target.files ?? []))} disabled={isPending} />
        <small>{coverImages.length} image files · ordered by filename to match the selected accounts.</small>
      </label>
      {selectedAccounts.length > 0 && <div className="page-selection-order"><strong>Account and image order</strong><ol>{selectedAccounts.slice(0, 8).map((account, index) => <li key={account.id}>{index + 1}. {account.label} <span>← CSV row {index + 1} · profile image {index + 1} · cover image {index + 1}</span></li>)}</ol>{selectedAccounts.length > 8 && <small>…and {selectedAccounts.length - 8} more selected accounts.</small>}</div>}
      <p className="page-form-note">Each image must be 10 MB or smaller. The selected account count, CSV row count, and image count in each folder must match. Facebook may ask for extra verification; the affected job will be reported and the profile will close after the group finishes.</p>
      <label className="page-form-test-mode"><input type="checkbox" checked={stopBeforeCreate} onChange={(event) => setStopBeforeCreate(event.target.checked)} disabled={isPending} /> Stop after entering and verifying the name, category, and bio; do not click Facebook’s Create Page button. Leave Cent profiles open for review.</label>
      <div className="page-form-actions"><button className="primary-button" type="button" onClick={startRun} disabled={isPending || !selectedIds.length || !category || !detailsCsv || !profileImages.length || !coverImages.length}>{isPending ? (stopBeforeCreate ? "Checking Page details…" : "Creating Pages…") : stopBeforeCreate ? `Test ${selectedIds.length || "selected"} Page forms` : `Create ${selectedIds.length || "selected"} Pages`}</button></div>
    </>}
    {progress && <p className="account-alert" role="status">{progress}</p>}
    {message && <pre className={`account-alert page-batch-result ${isError ? "error-alert" : "success-alert"}`} role={isError ? "alert" : "status"}>{message}</pre>}
  </section>;
}
