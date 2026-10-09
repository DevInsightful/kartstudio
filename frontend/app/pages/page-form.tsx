"use client";

import { useState, useTransition } from "react";
import { populatePageForm } from "./actions";

type AccountOption = { id: number; label: string };

export default function PageForm({ accounts }: { accounts: AccountOption[] }) {
  const [accountId, setAccountId] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [bio, setBio] = useState("");
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);
  const [isPending, startTransition] = useTransition();

  function populate() {
    setMessage("");
    setIsError(false);
    startTransition(async () => {
      try {
        const result = await populatePageForm(Number(accountId), name, category, bio);
        setMessage(result.message);
        setIsError(result.state !== "created-clicked");
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Could not populate the Facebook Page form.");
        setIsError(true);
      }
    });
  }

  return <section className="page-form-panel" aria-labelledby="page-form-title">
    <div className="page-form-heading">
      <div><p className="eyebrow">SINGLE PAGE · TEST</p><h3 id="page-form-title">Create one Facebook Page</h3>
        <p>Select one active account and enter details for a single Page. After verifying the populated fields and category selection, the helper clicks Create Page once.</p></div>
    </div>
    {accounts.length === 0 ? <p className="account-alert error-alert" role="status">No active accounts are available. Sign in to an account and verify its status in Accounts first.</p> : <>
      <label className="modal-field">Active Facebook account
        <select value={accountId} onChange={(event) => setAccountId(event.target.value)} disabled={isPending}>
          <option value="">Select an account</option>
          {accounts.map((account) => <option value={account.id} key={account.id}>{account.label}</option>)}
        </select>
      </label>
      <label className="modal-field">Page name
        <input value={name} onChange={(event) => setName(event.target.value)} maxLength={75} required disabled={isPending} />
      </label>
      <label className="modal-field">Category
        <input value={category} onChange={(event) => setCategory(event.target.value)} maxLength={100} required disabled={isPending} />
      </label>
      <label className="modal-field">Bio
        <textarea value={bio} onChange={(event) => setBio(event.target.value)} maxLength={500} rows={4} required disabled={isPending} />
      </label>
      <p className="page-form-note">The helper selects the exact matching category suggestion before clicking Create Page. Facebook may require additional information or confirmation. It never retries an uncertain click; check the Cent window before running it again.</p>
      <div className="page-form-actions"><button className="primary-button" type="button" onClick={populate} disabled={isPending || !accountId || !name.trim() || !category.trim() || !bio.trim()}>{isPending ? "Populating and creating…" : "Populate fields and click Create Page"}</button></div>
    </>}
    {message && <p className={`account-alert ${isError ? "error-alert" : "success-alert"}`} role={isError ? "alert" : "status"}>{message}</p>}
  </section>;
}
