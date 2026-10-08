"use client";

import { useMemo, useState, useTransition } from "react";
import { launchLoginBatch } from "./login-actions";
import { confirmProfilesClosed } from "./session-actions";

type LoginAccount = { id: number; label: string };

export default function LoginBatch({ accounts, onDone }: { accounts: LoginAccount[]; onDone: () => void }) {
  const [batchSize, setBatchSize] = useState(12);
  const [position, setPosition] = useState(0);
  const [attemptedBatch, setAttemptedBatch] = useState<LoginAccount[]>([]);
  const [activeBatch, setActiveBatch] = useState<LoginAccount[]>([]);
  const [failed, setFailed] = useState<string[]>([]);
  const [manualLoginIds, setManualLoginIds] = useState<number[]>([]);
  const [sessionReusedIds, setSessionReusedIds] = useState<number[]>([]);
  const [authenticatedIds, setAuthenticatedIds] = useState<number[]>([]);
  const [loginRequiredIds, setLoginRequiredIds] = useState<number[]>([]);
  const [unverifiedIds, setUnverifiedIds] = useState<number[]>([]);
  const [populationErrors, setPopulationErrors] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [isPending, startTransition] = useTransition();
  const remaining = useMemo(() => accounts.slice(position), [accounts, position]);
  const batchNumber = Math.floor(position / batchSize) + 1;
  const batchCount = Math.ceil(accounts.length / batchSize);

  function openBatch() {
    const batch = remaining.slice(0, batchSize);
    if (!batch.length) return;
    setError(""); setNotice(""); setFailed([]); setManualLoginIds([]); setSessionReusedIds([]); setAuthenticatedIds([]); setLoginRequiredIds([]); setUnverifiedIds([]); setPopulationErrors([]); setAttemptedBatch(batch); setActiveBatch(batch);
    startTransition(async () => {
      try {
        const result = await launchLoginBatch(batch.map(({ id }) => id));
        setFailed(result.failed);
        setManualLoginIds(result.manualLoginIds);
        setSessionReusedIds(result.sessionReusedIds);
        setAuthenticatedIds(result.authenticatedIds);
        setLoginRequiredIds(result.loginRequiredIds);
        setUnverifiedIds(result.unverifiedIds);
        setPopulationErrors(result.populationErrors);
        if (result.openedIds.length === 0) { setError("No browser profiles opened in this batch."); setActiveBatch([]); }
        else setActiveBatch(batch.filter(({ id }) => result.openedIds.includes(id)));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not open the selected Cent profiles.");
        setActiveBatch([]);
      }
    });
  }

  function continueBatch() {
    const completedCount = attemptedBatch.length;
    startTransition(async () => {
      try {
        await confirmProfilesClosed(attemptedBatch.map(({ id }) => id));
        setPosition((current) => Math.min(current + completedCount, accounts.length));
        setActiveBatch([]); setAttemptedBatch([]); setFailed([]); setError(""); setNotice("");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not update the closed profile state.");
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
      <p className="login-batch-copy">Choose how many account profiles to open at a time. Cent windows will be restored and tiled evenly. Facebook login state is checked and saved automatically; finish any checkpoint or 2FA prompt in Cent.</p>
      <label className="modal-field">Profiles per batch<input type="number" min={1} max={20} step={1} value={batchSize} disabled={position > 0} onChange={(event) => setBatchSize(Math.max(1, Math.min(20, Number(event.target.value) || 1)))} /></label>
      <div className="login-quick-select" aria-label="Quick select batch size">{[2, 4, 6, 8, 10, 12].map((size) => <button type="button" disabled={position > 0} className={batchSize === size ? "active" : ""} key={size} onClick={() => setBatchSize(size)}>{size}</button>)}</div>
      <p className="login-batch-progress">Batch {batchNumber} of {batchCount} · {remaining.length} account(s) remain.</p>
    </>}
    {isPending && <p className="account-inline-notice" role="status">Opening selected Cent profiles, checking saved sessions, and submitting credentials only when Facebook requests sign-in…</p>}
    {activeBatch.length > 0 && !isPending && <>
      <p className="account-inline-notice" role="status">Facebook&apos;s page state was checked after each profile opened. Verified login results were saved automatically; complete any checkpoint or 2FA prompt manually in Cent.</p>
      <ul className="login-batch-account-list">{activeBatch.map((account) => <li key={account.id}>{account.label}</li>)}</ul>
      {authenticatedIds.length > 0 && <p className="account-inline-notice" role="status">Login confirmed: {attemptedBatch.filter(({ id }) => authenticatedIds.includes(id)).map(({ label }) => label).join(", ")}.</p>}
      {loginRequiredIds.length > 0 && <p className="account-alert error-alert" role="alert">Login still required: {attemptedBatch.filter(({ id }) => loginRequiredIds.includes(id)).map(({ label }) => label).join(", ")}. Complete any checkpoint or 2FA prompt in Cent.</p>}
      {unverifiedIds.length > 0 && <p className="account-alert error-alert" role="alert">Could not verify login state: {attemptedBatch.filter(({ id }) => unverifiedIds.includes(id)).map(({ label }) => label).join(", ")}.</p>}
      {sessionReusedIds.length > 0 && <p className="account-inline-notice" role="status">Reused saved browser sessions for: {attemptedBatch.filter(({ id }) => sessionReusedIds.includes(id)).map(({ label }) => label).join(", ")}.</p>}
      {manualLoginIds.length > 0 && <div className="account-alert error-alert" role="alert"><p>Automatic login could not be completed for: {attemptedBatch.filter(({ id }) => manualLoginIds.includes(id)).map(({ label }) => label).join(", ")}.</p><ul>{populationErrors.map((item) => <li key={item}>{item}</li>)}</ul></div>}
      <p className="login-batch-progress">Batch {batchNumber} of {batchCount}</p>
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onDone}>Close</button><button type="button" className="primary-button" disabled={isPending} onClick={continueBatch}>{isPending ? "Saving…" : "Profiles closed · continue"}</button></div>
    </>}
    {finished && !activeBatch.length && <>
      <p className="account-inline-notice" role="status">All selected accounts have been checked. Verified Facebook login results were saved in the account list.</p>
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
