"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { publishReelGroup } from "./actions";

type PageOption = { id: string; name: string; accountId: number; accountLabel: string };
type ReelResult = { pageId: string; pageName: string; status: "PUBLISHED" | "FAILED"; message: string };
type FolderFile = File & { webkitRelativePath?: string };
const JOB_OPTIONS = Array.from({ length: 20 }, (_, index) => index + 1);
const VIDEO_EXTENSIONS = /\.(mp4|mov|webm|m4v|3gp|avi|mkv)$/i;
const MAX_VIDEO_BYTES = 400 * 1024 * 1024;

function sortVideos(files: FileList | File[]) {
  return Array.from(files).filter((file) => VIDEO_EXTENSIONS.test(file.name)).sort((a, b) => {
    const left = (a as FolderFile).webkitRelativePath || a.name;
    const right = (b as FolderFile).webkitRelativePath || b.name;
    return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
  });
}

async function duplicateVideos(files: File[]) {
  const seen = new Map<string, string>();
  for (const file of files) {
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (seen.has(key)) return `${file.name} has the same contents as ${seen.get(key)}.`;
    seen.set(key, file.name);
  }
  return "";
}

export default function ReelsForm({ pages }: { pages: PageOption[] }) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [jobsAtOnce, setJobsAtOnce] = useState(2);
  const [sharedDescription, setSharedDescription] = useState(true);
  const [sharedText, setSharedText] = useState("");
  const [descriptionsText, setDescriptionsText] = useState("");
  const [videos, setVideos] = useState<File[]>([]);
  const [results, setResults] = useState<ReelResult[]>([]);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);
  const [progress, setProgress] = useState("");
  const [isPending, startTransition] = useTransition();
  const folderRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    folderRef.current?.setAttribute("webkitdirectory", "");
    folderRef.current?.setAttribute("directory", "");
  }, []);

  const selected = useMemo(() => pages.filter((page) => selectedIds.includes(page.id)), [pages, selectedIds]);
  const descriptions = sharedDescription
    ? selected.map(() => sharedText.trim())
    : descriptionsText.split(/\r?\n/).map((line) => line.trim());

  function togglePage(id: string) {
    setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  function startPosting() {
    setMessage(""); setIsError(false); setResults([]); setProgress("");
    if (!selected.length) { setMessage("Select at least one active Facebook Page."); setIsError(true); return; }
    if (selected.length > 500) { setMessage("Select no more than 500 Pages in one run."); setIsError(true); return; }
    if (videos.length !== selected.length) { setMessage(`Choose a folder with exactly ${selected.length} videos, one for each selected Page.`); setIsError(true); return; }
    if (videos.some((file) => !file.type.startsWith("video/") || file.size <= 0 || file.size > MAX_VIDEO_BYTES)) {
      setMessage("Each video must be a supported video file between 1 byte and 400 MB."); setIsError(true); return;
    }
    if (descriptions.length !== selected.length || descriptions.some((description) => !description || description.length > 5000)) {
      setMessage(sharedDescription
        ? "Enter a shared description (up to 5,000 characters)."
        : `Enter exactly ${selected.length} non-empty descriptions, one per line, in Page order.`);
      setIsError(true); return;
    }

    startTransition(async () => {
      const duplicate = await duplicateVideos(videos);
      if (duplicate) { setMessage(`Remove duplicate videos before starting: ${duplicate}`); setIsError(true); return; }
      const collected: ReelResult[] = [];
      const pendingIndexes = selected.map((_, index) => index);
      const failedAccounts = new Set<number>();
      while (pendingIndexes.length) {
        const group: number[] = [];
        const usedAccounts = new Set<number>();
        for (let cursor = 0; cursor < pendingIndexes.length && group.length < jobsAtOnce;) {
          const index = pendingIndexes[cursor];
          const accountId = selected[index].accountId;
          if (failedAccounts.has(accountId)) {
            pendingIndexes.splice(cursor, 1);
            collected.push({ pageId: selected[index].id, pageName: selected[index].name, status: "FAILED", message: "Skipped because an earlier Page on this Facebook account failed; no additional profile was opened." });
            continue;
          }
          if (usedAccounts.has(accountId)) { cursor++; continue; }
          usedAccounts.add(accountId); group.push(index); pendingIndexes.splice(cursor, 1);
        }
        if (!group.length) {
          setResults([...collected]);
          break;
        }
        setProgress(`Posting Reels ${selected.length - pendingIndexes.length - group.length + 1}–${selected.length - pendingIndexes.length} of ${selected.length}…`);
        const formData = new FormData();
        formData.set("pageIds", JSON.stringify(selected.map((page) => page.id)));
        formData.set("groupIndexes", JSON.stringify(group));
        formData.set("descriptions", JSON.stringify(descriptions));
        for (const index of group) formData.append("videos", videos[index], videos[index].name);
        try {
          const result = await publishReelGroup(formData);
          collected.push(...result.results);
          for (const item of result.results) {
            if (item.status === "FAILED") {
              const failedPage = selected.find((page) => page.id === item.pageId);
              if (failedPage) failedAccounts.add(failedPage.accountId);
            }
          }
        } catch (error) {
          for (const index of group) {
            failedAccounts.add(selected[index].accountId);
            collected.push({ pageId: selected[index].id, pageName: selected[index].name, status: "FAILED", message: error instanceof Error ? error.message : "This posting batch failed." });
          }
        }
        setResults([...collected]);
      }
      setProgress("");
      const published = collected.filter((item) => item.status === "PUBLISHED").length;
      setMessage(`${published} of ${selected.length} Reels were confirmed by Facebook.`);
      setIsError(published !== selected.length);
    });
  }

  return <section className="page-form-panel reels-panel" aria-labelledby="reels-title">
    <div className="page-form-heading"><div><p className="eyebrow">REELS · BATCH PUBLISHING</p><h3 id="reels-title">Post Reels to selected Pages</h3>
      <p>Select Pages, then map videos from the chosen folder in natural filename order. Jobs run in groups; Pages owned by the same Facebook account are placed in separate groups.</p></div></div>

    {!pages.length ? <p className="account-alert error-alert" role="status">No active Pages are available. Load Pages from active Facebook accounts first.</p> : <>
      <div className="reels-toolbar"><strong>{selected.length} Pages selected</strong><button type="button" onClick={() => setSelectedIds(selected.length === pages.length ? [] : pages.map((page) => page.id))} disabled={isPending}>{selected.length === pages.length ? "Clear selection" : "Select all Pages"}</button></div>
      <div className="reels-page-list" role="group" aria-label="Select Facebook Pages">
        {pages.map((page) => <label className="reels-page-option" key={page.id}>
          <input type="checkbox" checked={selectedIds.includes(page.id)} onChange={() => togglePage(page.id)} disabled={isPending} />
          <span><strong>{page.name}</strong><small>{page.accountLabel}</small></span>
          {selectedIds.includes(page.id) && <em>#{selected.findIndex((item) => item.id === page.id) + 1}</em>}
        </label>)}
      </div>
      <label className="modal-field">Video folder
        <input ref={folderRef} type="file" multiple accept="video/*,.mp4,.mov,.webm,.m4v,.3gp,.avi,.mkv" onChange={(event) => setVideos(sortVideos(event.target.files ?? []))} disabled={isPending} />
        <small>{videos.length ? `${videos.length} videos selected · ${videos.map((file) => file.name).join(", ")}` : "Choose a folder with exactly one supported video per Page. Files map by natural filename order."}</small>
      </label>
      <label className="modal-field">Jobs at once
        <select value={jobsAtOnce} onChange={(event) => setJobsAtOnce(Number(event.target.value))} disabled={isPending}>
          {JOB_OPTIONS.map((count) => <option key={count} value={count}>{count} at a time</option>)}
        </select><small>Each batch opens up to this many distinct Facebook account profiles. Successful profiles close after posting; failed profiles stay open for review.</small>
      </label>
      <fieldset className="reels-description-mode"><legend>Description mapping</legend>
        <label><input type="radio" checked={sharedDescription} onChange={() => setSharedDescription(true)} disabled={isPending} /> Use the same description for every Reel</label>
        <label><input type="radio" checked={!sharedDescription} onChange={() => setSharedDescription(false)} disabled={isPending} /> Enter one description per Page</label>
      </fieldset>
      {sharedDescription ? <label className="modal-field">Shared description
        <textarea rows={4} maxLength={5000} value={sharedText} onChange={(event) => setSharedText(event.target.value)} disabled={isPending} placeholder="Describe all selected Reels…" />
      </label> : <label className="modal-field">Descriptions, one per line in Page order
        <textarea rows={8} value={descriptionsText} onChange={(event) => setDescriptionsText(event.target.value)} disabled={isPending} placeholder={selected.map((page, index) => `Description ${index + 1} for ${page.name}`).join("\n")} />
        <small>{descriptionsText.split(/\r?\n/).length} lines · exactly {selected.length} non-empty lines required.</small>
      </label>}
      {selected.length > 0 && <div className="reels-mapping"><strong>Publishing order</strong>{selected.map((page, index) => <p key={page.id}><span>{index + 1}.</span> {videos[index]?.name ?? `Video ${index + 1}`} → {page.name} · {sharedDescription ? "shared description" : descriptions[index] || "description pending"}</p>)}</div>}
      {message && <p className={`account-alert ${isError ? "error-alert" : ""}`} role="status">{message}</p>}
      {progress && <p className="reels-progress" role="status">{progress}</p>}
      {!!results.length && <div className="reels-results"><strong>Batch results</strong>{results.map((item) => <p key={item.pageId}><span className={item.status === "PUBLISHED" ? "reels-success" : "reels-failure"}>{item.status === "PUBLISHED" ? "✓" : "!"}</span> {item.pageName}: {item.message}</p>)}</div>}
      <button className="primary-button reels-submit" type="button" onClick={startPosting} disabled={isPending || !pages.length}>{isPending ? "Publishing…" : `Publish ${selected.length || ""} Reels`}</button>
    </>}
  </section>;
}
