"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { uploadProfessionalDashboardFiles } from "./actions";

type PageOption = { id: string; name: string; accountId: number; accountLabel: string };
const MAX_FILES = 20;
const MAX_TOTAL_FILES = 100;
const MAX_TOTAL_BYTES = 400 * 1024 * 1024;
const VIDEO_EXTENSIONS = /\.(mp4|mov|webm|m4v|3gp|avi|mkv)$/i;
const BATCH_OPTIONS = [1, 2, 3, 4, 5, 10, 12];
type FolderFile = File & { webkitRelativePath?: string };

function sortVideos(files: FileList | File[]) {
  return Array.from(files).filter((file) => VIDEO_EXTENSIONS.test(file.name)).sort((a, b) =>
    ((a as FolderFile).webkitRelativePath || a.name).localeCompare((b as FolderFile).webkitRelativePath || b.name, undefined, { numeric: true, sensitivity: "base" }));
}

function normalizeFolderName(name: string) {
  return name.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function pathParts(file: File) {
  return ((file as FolderFile).webkitRelativePath || "").split("/").filter(Boolean);
}

type PageFolder = { files: File[]; folderName: string; source: "auto" | "manual" | "missing" };

export default function ProfessionalDashboardForm({ pages = [] }: { pages?: PageOption[] }) {
  const accounts = useMemo(() => Array.from(
    new Map(pages.map((page) => [page.accountId, page.accountLabel] as const)),
    ([id, label]) => ({ id, label }),
  ), [pages]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [expandedAccount, setExpandedAccount] = useState<number | null>(accounts.length > 0 ? accounts[0].id : null);
  const [batchSize, setBatchSize] = useState(4);
  const [description, setDescription] = useState("");
  const [singlePageVideos, setSinglePageVideos] = useState<File[]>([]);
  const [parentFolderVideos, setParentFolderVideos] = useState<File[]>([]);
  const [manualFolders, setManualFolders] = useState<Record<string, { files: File[]; folderName: string }>>({});
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);
  const [progress, setProgress] = useState("");
  const [isPending, startTransition] = useTransition();
  const folderRef = useRef<HTMLInputElement>(null);
  const pageFolderRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const selectedPages = useMemo(() => selectedIds.map((id) => pages.find((page) => page.id === id)).filter((page): page is PageOption => !!page), [pages, selectedIds]);
  const singlePageBatch = selectedPages.length === 1;
  const pageFolders = useMemo(() => selectedPages.map((page): PageFolder => {
    const manual = manualFolders[page.id];
    if (manual) return { ...manual, source: "manual" };
    const matchingPages = selectedPages.filter((candidate) => normalizeFolderName(candidate.name) === normalizeFolderName(page.name));
    const files = parentFolderVideos.filter((file) => {
      const parts = pathParts(file);
      return parts.length >= 3 && normalizeFolderName(parts[1]) === normalizeFolderName(page.name);
    });
    if (matchingPages.length > 1) return { files: [], folderName: "", source: "missing" };
    return files.length ? { files, folderName: pathParts(files[0])[1], source: "auto" } : { files: [], folderName: "", source: "missing" };
  }), [manualFolders, parentFolderVideos, selectedPages]);
  const totalVideos = singlePageBatch ? singlePageVideos.length : pageFolders.reduce((sum, folder) => sum + folder.files.length, 0);
  const totalBytes = useMemo(() => (singlePageBatch ? singlePageVideos : pageFolders.flatMap((folder) => folder.files)).reduce((sum, video) => sum + video.size, 0), [pageFolders, singlePageBatch, singlePageVideos]);
  const targetCount = totalVideos;

  useEffect(() => {
    folderRef.current?.setAttribute("webkitdirectory", "");
    folderRef.current?.setAttribute("directory", "");
  }, []);

  function togglePage(id: string) {
    setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
    setSinglePageVideos([]); setParentFolderVideos([]); setManualFolders({});
  }

  function selectAllPages() {
    setSelectedIds((current) => current.length === pages.length ? [] : pages.map((page) => page.id));
    setSinglePageVideos([]); setParentFolderVideos([]); setManualFolders({});
  }

  function handleFolderChange(files: FileList | null) {
    if (!files) return;
    if (singlePageBatch) {
      setSinglePageVideos(sortVideos(files));
      return;
    }
    setParentFolderVideos(sortVideos(files));
    setManualFolders({});
  }

  function handlePageFolderChange(pageId: string, files: FileList | null) {
    if (!files?.length) return;
    const videos = sortVideos(files);
    if (!videos.length) {
      setManualFolders((current) => { const next = { ...current }; delete next[pageId]; return next; });
      setMessage("The selected folder does not contain any supported videos."); setIsError(true);
      return;
    }
    const folderName = pathParts(videos[0])[0] || "Selected folder";
    setManualFolders((current) => ({ ...current, [pageId]: { files: videos, folderName } }));
  }

  function submit() {
    setMessage(""); setIsError(false);
    if (!selectedPages.length) { setMessage("Select at least one Facebook Page."); setIsError(true); return; }
    if (singlePageBatch && !singlePageVideos.length) { setMessage("Choose at least one Reel for the selected Page."); setIsError(true); return; }
    if (!singlePageBatch && pageFolders.some((folder) => !folder.files.length)) {
      setMessage("Choose a parent folder with a matching subfolder for each Page, or select a folder for each unmatched Page."); setIsError(true); return;
    }
    if (singlePageBatch && singlePageVideos.length > MAX_FILES) { setMessage(`Choose no more than ${MAX_FILES} videos for one Page per run.`); setIsError(true); return; }
    if (!singlePageBatch && pageFolders.some((folder) => folder.files.length > MAX_FILES)) { setMessage(`Each Page can have no more than ${MAX_FILES} videos per run.`); setIsError(true); return; }
    if (totalVideos > MAX_TOTAL_FILES) { setMessage(`Choose no more than ${MAX_TOTAL_FILES} videos per run.`); setIsError(true); return; }
    const assignedVideos = singlePageBatch ? singlePageVideos : pageFolders.flatMap((folder) => folder.files);
    if (assignedVideos.some((video) => video.size <= 0) || totalBytes > MAX_TOTAL_BYTES) { setMessage("Selected videos must be non-empty and total no more than 400 MB."); setIsError(true); return; }
    if (pageFolders.some((folder) => {
      const names = new Set(folder.files.map((video) => video.name.toLocaleLowerCase()));
      return names.size !== folder.files.length;
    })) { setMessage("Each Page folder must contain videos with different filenames."); setIsError(true); return; }

    startTransition(async () => {
      setProgress("Opening the owning Cent profile. If Facebook asks for sign-in or a security check, complete it in Cent and KartStudio will resume automatically. Each Page’s bulk upload is saved to Content Library before continuing.");
      try {
        const data = new FormData();
        data.set("pageIds", JSON.stringify(selectedPages.map((page) => page.id)));
        data.set("singlePageBatch", String(singlePageBatch));
        data.set("batchSize", String(batchSize));
        data.set("description", description);
        if (singlePageBatch) {
          singlePageVideos.forEach((video) => data.append("videos", video, video.name));
        } else {
          const counts = pageFolders.map((folder) => folder.files.length);
          data.set("pageVideoCounts", JSON.stringify(counts));
          pageFolders.forEach((folder) => folder.files.forEach((video) => data.append("videos", video, video.name)));
        }
        const result = await uploadProfessionalDashboardFiles(data);
        setMessage(result.message); setIsError(false);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "The Professional Dashboard upload did not finish."); setIsError(true);
      } finally { setProgress(""); }
    });
  }

  return <section className="page-form-panel professional-upload-panel" aria-labelledby="professional-upload-title">
    <div className="page-form-heading"><div><p className="eyebrow">PROFESSIONAL DASHBOARD</p><h3 id="professional-upload-title">Upload Reels to Pages</h3>
      <p>Choose one Page to upload every video from its folder together, or select multiple Pages and upload a parent folder with one subfolder per Page. For multiple Pages, choose how many different account profiles to process at once.</p></div></div>
    {!pages.length ? <div className="account-empty-state"><span className="empty-state-mark">!</span><h3>No active Pages</h3><p>Load Pages from active Facebook accounts first.</p><Link className="professional-upload-back" href="/pages">Open Pages</Link></div> : <>
      <div className="reels-toolbar"><strong>{selectedPages.length} Pages selected</strong><button type="button" onClick={selectAllPages} disabled={isPending}>{selectedPages.length === pages.length ? "Clear selection" : "Select all Pages"}</button></div>
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
      <label className="modal-field">{singlePageBatch ? "Reel folder for this Page" : "Parent folder (one subfolder per Page)"}
        <input ref={folderRef} type="file" multiple accept="video/*,.mp4,.mov,.webm,.m4v,.3gp,.avi,.mkv" onChange={(event) => handleFolderChange(event.target.files)} disabled={isPending} />
        <small>{singlePageBatch ? (singlePageVideos.length ? `${singlePageVideos.length} videos selected · ${(totalBytes / (1024 * 1024)).toFixed(1)} MB` : "Select a folder containing the Reels for this Page.") : (parentFolderVideos.length ? `${parentFolderVideos.length} videos found in parent folder · ${totalVideos} assigned · ${(totalBytes / (1024 * 1024)).toFixed(1)} MB` : "Select a parent folder containing subfolders named after the selected Pages, for example Parent Folder/Page Name/video.mp4.")}</small>
      </label>
      {!singlePageBatch && selectedPages.length > 0 && <>
      <label className="modal-field">Profiles per batch
        <input type="number" min={1} max={20} step={1} value={batchSize} onChange={(event) => setBatchSize(Math.max(1, Math.min(20, Number(event.target.value) || 1)))} disabled={isPending} />
        <small>Open and upload to up to this many different account profiles at once. Pages from the same account run one at a time.</small>
      </label>
      <div className="login-quick-select" aria-label="Quick select profiles per batch">{BATCH_OPTIONS.map((size) => <button type="button" disabled={isPending} className={batchSize === size ? "active" : ""} key={size} onClick={() => setBatchSize(size)}>{size}</button>)}</div>
      <div className="professional-upload-order"><strong>Page and folder mapping</strong><ol>{selectedPages.map((page, index) => {
        const folder = pageFolders[index];
        const duplicateName = selectedPages.filter((candidate) => normalizeFolderName(candidate.name) === normalizeFolderName(page.name)).length > 1;
        return <li key={page.id}>
          <strong>{page.name}</strong>
          <small>{folder.files.length ? `${folder.source === "auto" ? "Auto-detected" : "Selected"}: ${folder.folderName} · ${folder.files.length} video${folder.files.length === 1 ? "" : "s"}` : duplicateName ? "Multiple selected Pages share this name; choose a folder manually." : "No matching subfolder detected; choose a folder."}</small>
          <button type="button" className="professional-upload-folder-button" onClick={() => pageFolderRefs.current[page.id]?.click()} disabled={isPending}>{folder.files.length ? "Change folder" : "Select folder"}</button>
          <input ref={(element) => { if (element) { element.setAttribute("webkitdirectory", ""); element.setAttribute("directory", ""); pageFolderRefs.current[page.id] = element; } else delete pageFolderRefs.current[page.id]; }} type="file" multiple accept="video/*,.mp4,.mov,.webm,.m4v,.3gp,.avi,.mkv" hidden onChange={(event) => { handlePageFolderChange(page.id, event.target.files); event.target.value = ""; }} disabled={isPending} />
        </li>;
      })}</ol><small>Each Page gets all videos from its assigned folder. Maximum {MAX_FILES} videos per Page.</small></div>
      </>}
      <label className="modal-field">Reel description <span className="field-optional">optional</span>
        <textarea rows={4} maxLength={5000} value={description} onChange={(event) => setDescription(event.target.value)} disabled={isPending} placeholder="This description will be added to every uploaded video…" />
        <small>The same description is added to every video uploaded to every selected Page.</small>
      </label>
      <p className="professional-upload-note">Maximum {MAX_FILES} videos per Page, {MAX_TOTAL_FILES} videos and 400 MB per run. Bulk uploads are saved to Content Library for review; KartStudio does not click the final Publish or Share button.</p>
      {progress && <p className="reels-progress" role="status">{progress}</p>}
      {message && <p className={`account-alert ${isError ? "error-alert" : "success-alert"}`} role={isError ? "alert" : "status"}>{message}</p>}
      <button className="primary-button reels-submit" type="button" onClick={submit} disabled={isPending || !selectedPages.length}>{isPending ? "Uploading to Facebook…" : `Upload ${targetCount || "selected"} Reel${targetCount === 1 ? "" : "s"} to ${selectedPages.length || "selected"} Page${selectedPages.length === 1 ? "" : "s"}`}</button>
    </>}
  </section>;
}
