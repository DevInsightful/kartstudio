"use client";

import { useMemo, useState, useTransition } from "react";
import { launchLoginBatch } from "./login-actions";
import { confirmProfilesClosed, recordLoginBatchResults } from "./session-actions";

type LoginAccount = { id: number; label: string };

export default function LoginBatch({ accounts, onDone }: { accounts: LoginAccount[]; onDone: () => void }) {
  const [batchSize, setBatchSize] = useState(12);
  const [position, setPosition] = useState(0);
  const [attemptedBatch, setAttemptedBatch] = useState<LoginAccount[]>([]);
  const [activeBatch, setActiveBatch] = useState<LoginAccount[]>([]);
  const [activeIds, setActiveIds] = useState<number[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [failed, setFailed] = useState<string[]>([]);
  const [manualLoginIds, setManualLoginIds] = useState<number[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [isPending, startTransition] = useTransition();
  const remaining = useMemo(() => accounts.slice(position), [accounts, position]);
  const batchNumber = Math.floor(position / batchSize) + 1;
  const batchCount = Math.ceil(accounts.length / batchSize);

  function openBatch() {
    const batch = remaining.slice(0, batchSize);
    if (!batch.length) return;
    setError(""); setNotice(""); setFailed([]); setManualLoginIds([]); setAttemptedBatch(batch); setActiveBatch(batch); setReviewing(false); setActiveIds([]);
    startTransition(async () => {
      try {
        const result = await launchLoginBatch(batch.map(({ id }) => id));
        setFailed(result.failed);
        setManualLoginIds(result.manualLoginIds);
        if (result.openedIds.length === 0) { setError("No browser profiles opened in this batch."); setActiveBatch([]); }
        else { setActiveBatch(batch.filter(({ id }) => result.openedIds.includes(id))); setActiveIds([]); }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not open the selected Cent profiles.");
        setActiveBatch([]);
      }
    });
  }

  function saveBatchResults() {
    const completedCount = attemptedBatch.length;
    startTransition(async () => {
      try {
        await recordLoginBatchResults(attemptedBatch.map(({ id }) => id), activeIds);
        setPosition((current) => Math.min(current + completedCount, accounts.length));
        setActiveBatch([]); setAttemptedBatch([]); setActiveIds([]); setFailed([]); setError(""); setNotice(""); setReviewing(false);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not save the login results.");
      }
    });
  }

  function resetClosedProfiles() {
    setError(""); setNotice("");
    startTransition(async () => {
      try {
        await confirmProfilesClosed(attemptedBatch.map(({ id }) => id));
        setFailed([]);
        setNotice("Closed profile status saved. Start this batch again to retry.");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not reset the profile state.");
      }
    });
  }

  const finished = position >= accounts.length;
  return <div className="account-modal-backdrop" role="presentation"><section className="account-modal login-batch-modal" role="dialog" aria-modal="true" aria-labelledby="login-batch-title">
    <button className="modal-close" type="button" disabled={isPending} onClick={onDone} aria-label="Close">×</button>
    <p className="eyebrow">{accounts.length} SELECTED</p>
    <h3 id="login-batch-title">Open Cent login profiles</h3>
    {!activeBatch.length && !finished && <>
      <p className="login-batch-copy">Choose how many separate account profiles to open at a time. You will sign in and complete any 2FA prompts in Cent.</p>
      <label className="modal-field">Profiles per batch<input type="number" min={1} max={20} step={1} value={batchSize} disabled={position > 0} onChange={(event) => setBatchSize(Math.max(1, Math.min(20, Number(event.target.value) || 1)))} /></label>
      <div className="login-quick-select" aria-label="Quick select batch size">{[2, 4, 6, 8, 10, 12].map((size) => <button type="button" disabled={position > 0} className={batchSize === size ? "active" : ""} key={size} onClick={() => setBatchSize(size)}>{size}</button>)}</div>
      <p className="login-batch-progress">Batch {batchNumber} of {batchCount} · {remaining.length} account(s) remain.</p>
    </>}
    {isPending && <p className="account-inline-notice" role="status">Starting isolated Cent profiles…</p>}
    {activeBatch.length > 0 && !isPending && !reviewing && <>
      <p className="account-inline-notice" role="status">Opened {activeBatch.length} profile(s). Saved credentials were submitted where available. Complete any Facebook checkpoint or 2FA prompt in Cent, then close every Cent window for this batch.</p>
      <ul className="login-batch-account-list">{activeBatch.map((account) => <li key={account.id}>{account.label}</li>)}</ul>
      {manualLoginIds.length > 0 && <p className="account-alert error-alert" role="alert">Automatic sign-in needs attention for: {attemptedBatch.filter(({ id }) => manualLoginIds.includes(id)).map(({ label }) => label).join(", ")}. Finish sign-in manually in the corresponding Cent windows.</p>}
      <p className="login-batch-progress">Batch {batchNumber} of {batchCount}</p>
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onDone}>Close</button><button type="button" className="primary-button" onClick={() => setReviewing(true)}>Windows closed · record results</button></div>
    </>}
    {activeBatch.length > 0 && !isPending && reviewing && <>
      <p className="login-batch-copy">Select each account where you completed sign-in. Unchecked accounts will be recorded as Login required.</p>
      <ul className="login-result-list">{attemptedBatch.map((account) => <li key={account.id}><label><input type="checkbox" checked={activeIds.includes(account.id)} onChange={(event) => setActiveIds((current) => event.target.checked ? [...current, account.id] : current.filter((id) => id !== account.id))} /> <span>{account.label}</span></label></li>)}</ul>
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setReviewing(false)}>Back</button><button type="button" className="primary-button" disabled={isPending} onClick={saveBatchResults}>{isPending ? "Saving…" : "Save results · continue"}</button></div>
    </>}
    {finished && !activeBatch.length && <>
      <p className="account-inline-notice" role="status">All selected accounts have been opened in batches. Login completion is not detected by the app.</p>
      <div className="modal-actions"><button type="button" className="primary-button" onClick={onDone}>Done</button></div>
    </>}
    {failed.length > 0 && <div className="login-batch-errors" role="alert"><strong>Could not open:</strong><ul>{failed.map((item) => <li key={item}>{item}</li>)}</ul></div>}
    {failed.some((item) => item.includes("already marked open")) && !activeBatch.length && <p className="login-batch-copy">If you have closed the Cent window for this account, clear the saved open status before retrying.</p>}
    {failed.some((item) => item.includes("already marked open")) && !activeBatch.length && <button type="button" className="text-action" disabled={isPending} onClick={resetClosedProfiles}>I closed the Cent windows · reset profile state</button>}
    {notice && <p className="account-inline-notice" role="status">{notice}</p>}
    {error && <p className="account-alert error-alert" role="alert">{error}</p>}
    {!activeBatch.length && !finished && <div className="modal-actions"><button type="button" className="secondary-button" onClick={onDone}>Cancel</button><button type="button" className="primary-button" disabled={isPending} onClick={openBatch}>{isPending ? "Opening…" : `Start batch (${Math.min(batchSize, remaining.length)})`}</button></div>}
  </section></div>;
}
