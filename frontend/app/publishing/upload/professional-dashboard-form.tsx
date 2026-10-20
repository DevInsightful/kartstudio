"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { uploadProfessionalDashboardFiles } from "./actions";

type PageOption = { id: string; name: string; accountId: number; accountLabel: string };
const MAX_FILES = 20;
const MAX_TOTAL_BYTES = 400 * 1024 * 1024;
const VIDEO_EXTENSIONS = /\.(mp4|mov|webm|m4v|3gp|avi|mkv)$/i;
const BATCH_OPTIONS = [1, 2, 4, 6, 8, 10, 12, 16, 20];
type FolderFile = File & { webkitRelativePath?: string };

function sortVideos(files: FileList | File[]) {
  return Array.from(files).filter((file) => VIDEO_EXTENSIONS.test(file.name)).sort((a, b) =>
    ((a as FolderFile).webkitRelativePath || a.name).localeCompare((b as FolderFile).webkitRelativePath || b.name, undefined, { numeric: true, sensitivity: "base" }));
}

export default function ProfessionalDashboardForm({ pages = [] }: { pages?: PageOption[] }) {
  const accounts = useMemo(() => Array.from(
    new Map(pages.map((page) => [page.accountId, page.accountLabel] as const)),
    ([id, label]) => ({ id, label }),
  ), [pages]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [expandedAccount, setExpandedAccount] = useState<number | null>(accounts.length > 0 ? accounts[0].id : null);
  const [batchSize, setBatchSize] = useState(4);
  const [description, setDescription] = useState("");
  const [videos, setVideos] = useState<File[]>([]);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);
  const [progress, setProgress] = useState("");
  const [isPending, startTransition] = useTransition();
  const folderRef = useRef<HTMLInputElement>(null);
  const selectedPages = useMemo(() => selectedIds.map((id) => pages.find((page) => page.id === id)).filter((page): page is PageOption => !!page), [pages, selectedIds]);
  const totalBytes = useMemo(() => videos.reduce((sum, video) => sum + video.size, 0), [videos]);
  const singlePageBatch = selectedPages.length === 1;
  const targetCount = singlePageBatch ? videos.length : selectedPages.length;

  useEffect(() => {
    folderRef.current?.setAttribute("webkitdirectory", "");
    folderRef.current?.setAttribute("directory", "");
  }, []);

  function togglePage(id: string) {
    setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  function submit() {
    setMessage(""); setIsError(false);
    if (!selectedPages.length) { setMessage("Select at least one Facebook Page."); setIsError(true); return; }
    if (!videos.length || (!singlePageBatch && videos.length !== selectedPages.length)) {
      setMessage(singlePageBatch ? "Choose at least one Reel for the selected Page." : `Choose a video directory with exactly ${selectedPages.length} videos, one for each selected Page.`); setIsError(true); return;
    }
    if (videos.length > MAX_FILES) { setMessage(`Choose no more than ${MAX_FILES} videos per run.`); setIsError(true); return; }
    if (videos.some((video) => video.size <= 0) || totalBytes > MAX_TOTAL_BYTES) { setMessage("Selected videos must be non-empty and total no more than 400 MB."); setIsError(true); return; }

    startTransition(async () => {
      setProgress("Opening the owning Cent profile. If Facebook asks for sign-in or a security check, complete it in Cent and KartStudio will resume automatically. Saved bulk batches close their profile before the next batch starts.");
      try {
        const data = new FormData();
        data.set("pageIds", JSON.stringify(selectedPages.map((page) => page.id)));
        data.set("singlePageBatch", String(singlePageBatch));
        data.set("batchSize", String(batchSize));
        data.set("description", description);
        videos.forEach((video) => data.append("videos", video, video.name));
        const result = await uploadProfessionalDashboardFiles(data);
        setMessage(result.message); setIsError(false);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "The Professional Dashboard upload did not finish."); setIsError(true);
      } finally { setProgress(""); }
    });
  }

  return <section className="page-form-panel professional-upload-panel" aria-labelledby="professional-upload-title">
    <div className="page-form-heading"><div><p className="eyebrow">PROFESSIONAL DASHBOARD</p><h3 id="professional-upload-title">Upload Reels to Pages</h3>
      <p>Choose Pages under their owning Facebook accounts. With multiple Pages, videos map one-to-one in filename order. With one Page, upload a Reel batch to that Page.</p></div></div>
    {!pages.length ? <div className="account-empty-state"><span className="empty-state-mark">!</span><h3>No active Pages</h3><p>Load Pages from active Facebook accounts first.</p><Link className="professional-upload-back" href="/pages">Open Pages</Link></div> : <>
      <div className="reels-toolbar"><strong>{selectedPages.length} Pages selected</strong><button type="button" onClick={() => setSelectedIds(selectedPages.length === pages.length ? [] : pages.map((page) => page.id))} disabled={isPending}>{selectedPages.length === pages.length ? "Clear selection" : "Select all Pages"}</button></div>
      <div className="professional-upload-account-list" role="group" aria-label="Facebook accounts and Pages">
        {accounts.map(({ id: accountId, label }) => {
          const accountPages = pages.filter((page) => page.accountId === accountId);
          const selectedCount = accountPages.filter((page) => selectedIds.includes(page.id)).length;
          const expanded = expandedAccount === accountId;
          return <section className="professional-upload-account" key={accountId}>
            <div className="professional-upload-account-heading"><strong>{label}</strong><button type="button" aria-expanded={expanded} onClick={() => setExpandedAccount(expanded ? null : accountId)} disabled={isPending}>{expanded ? "Hide Pages" : `View Pages (${accountPages.length})`}</button></div>
            {expanded && <div className="reels-page-list">{accountPages.map((page) => <label className="reels-page-option" key={page.id}>
              <input type="checkbox" checked={selectedIds.includes(page.id)} onChange={() => togglePage(page.id)} disabled={isPending} />
              <span><strong>{page.name}</strong><small>{label}</small></span>{selectedIds.includes(page.id) && <em>#{selectedPages.findIndex((item) => item.id === page.id) + 1}</em>}
            </label>)}<small>{selectedCount} of {accountPages.length} Pages selected</small></div>}
          </section>;
        })}
      </div>
      <label className="modal-field">{singlePageBatch ? "Reel folder for this Page" : "Video folder (one video per Page)"}
        <input ref={folderRef} type="file" multiple accept="video/*,.mp4,.mov,.webm,.m4v,.3gp,.avi,.mkv" onChange={(event) => setVideos(sortVideos(event.target.files ?? []))} disabled={isPending} />
        <small>{videos.length ? `${videos.length} videos selected · ${(totalBytes / (1024 * 1024)).toFixed(1)} MB · ${videos.map((video) => video.name).join(", ")}` : singlePageBatch ? "Select a folder containing the Reels for this Page." : `Select a folder with exactly ${selectedPages.length || "one video per selected Page"}; natural filename order maps to Page order.`}</small>
      </label>
      {singlePageBatch && <label className="modal-field">How many Reels to upload at one time?
        <select value={batchSize} onChange={(event) => setBatchSize(Number(event.target.value))} disabled={isPending}>{BATCH_OPTIONS.map((count) => <option key={count} value={count}>{count} at a time</option>)}</select>
        <small>Videos for the selected Page are uploaded in batches of this size.</small>
      </label>}
      <label className="modal-field">Reel description <span className="field-optional">optional</span>
        <textarea rows={4} maxLength={5000} value={description} onChange={(event) => setDescription(event.target.value)} disabled={isPending} placeholder="Add a description for single-Reel composer uploads…" />
        <small>Used when Facebook opens the single-Reel composer. Bulk uploads remain in Content Library for your review.</small>
      </label>
      {!singlePageBatch && selectedPages.length > 0 && <div className="professional-upload-order"><strong>Page and video mapping</strong><ol>{selectedPages.map((page, index) => <li key={page.id}>{videos[index]?.name ?? `Video ${index + 1}`} → {page.name} <small>({page.accountLabel})</small></li>)}</ol><small>Page count and video count must match exactly.</small></div>}
      <p className="professional-upload-note">Maximum 20 videos and 400 MB per run. Single Reels open the composer; KartStudio does not click the final Publish or Share button. Bulk uploads remain in Content Library.</p>
      {progress && <p className="reels-progress" role="status">{progress}</p>}
      {message && <p className={`account-alert ${isError ? "error-alert" : "success-alert"}`} role={isError ? "alert" : "status"}>{message}</p>}
      <button className="primary-button reels-submit" type="button" onClick={submit} disabled={isPending || !selectedPages.length}>{isPending ? "Uploading to Facebook…" : `Upload ${targetCount || "selected"} Reel${targetCount === 1 ? "" : "s"}`}</button>
    </>}
  </section>;
}
