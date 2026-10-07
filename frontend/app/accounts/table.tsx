"use client";
import { useMemo, useState } from "react";
import { addNotes, addTags, assignCategory, bulkTrashAccounts, bulkUpdateAccounts, renameAccount, restoreAccount, trashAccount } from "./actions";
import LoginBatch from "./login-batch";

type Account = { id: number; code: string; displayName: string; username: string | null; category: string | null; categoryId: string | null; tags: string[]; notes: string | null; status: string; hasCredentials: boolean };
type Category = { id: string; name: string };
type ModalKind = "category" | "tags" | "notes" | "edit" | "delete" | "login" | null;
type EditDraft = { id: number; displayName: string; categoryId: string; tags: string; notes: string };

export default function AccountsTable({ accounts, categories, trash }: { accounts: Account[]; categories: Category[]; trash: boolean }) {
  const [selected, setSelected] = useState<number[]>([]); const [modal, setModal] = useState<ModalKind>(null);
  const [createNew, setCreateNew] = useState(false); const [category, setCategory] = useState(""); const [feedback, setFeedback] = useState("");
  const [revealed, setRevealed] = useState<{ id: number; password: string } | null>(null);
  const [revealingId, setRevealingId] = useState<number | null>(null); const [passwordError, setPasswordError] = useState("");
  const [editDrafts, setEditDrafts] = useState<EditDraft[]>([]);
  const ids = useMemo(() => accounts.map((account) => account.id), [accounts]);
  const allSelected = ids.length > 0 && ids.every((id) => selected.includes(id));
  function toggleAll() { setSelected(allSelected ? selected.filter((id) => !ids.includes(id)) : [...new Set([...selected, ...ids])]); }
  function toggle(id: number) { setSelected((current) => current.includes(id) ? current.filter((x) => x !== id) : [...current, id]); }
  function closeModal() { setModal(null); setCreateNew(false); setCategory(""); }
  function openBulkEdit() {
    setEditDrafts(accounts.filter((account) => selected.includes(account.id)).map((account) => ({
      id: account.id, displayName: account.displayName, categoryId: account.categoryId ?? "", tags: account.tags.join(", "), notes: account.notes ?? "",
    })));
    setModal("edit");
  }
  function updateDraft(id: number, field: keyof Omit<EditDraft, "id">, value: string) {
    setEditDrafts((drafts) => drafts.map((draft) => draft.id === id ? { ...draft, [field]: value } : draft));
  }
  async function togglePassword(id: number) {
    setPasswordError("");
    if (revealed?.id === id) { setRevealed(null); return; }
    setRevealingId(id);
    try {
      const response = await fetch("/accounts/credential", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
      const result = await response.json() as { password?: string; error?: string };
      if (!response.ok || typeof result.password !== "string") throw new Error(result.error ?? "Could not reveal password.");
      setRevealed({ id, password: result.password });
    } catch (error) { setPasswordError(error instanceof Error ? error.message : "Could not reveal password."); }
    finally { setRevealingId(null); }
  }
  const action = modal === "category" ? assignCategory : modal === "tags" ? addTags : addNotes;
  return <>
    {!trash && <div className="account-selection-toolbar"><label><input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all accounts" /> Select all</label><span>{selected.length} selected</span><button type="button" disabled={!selected.length} onClick={openBulkEdit}>Bulk edit</button><button type="button" disabled={!selected.length} onClick={() => setModal("category")}>Add to categories</button><button type="button" disabled={!selected.length} onClick={() => setModal("tags")}>Add tags</button><button type="button" disabled={!selected.length} onClick={() => setModal("notes")}>Add notes</button><button type="button" disabled={!selected.length} onClick={() => setModal("login")}>Open login profiles</button><button type="button" className="bulk-delete-button" disabled={!selected.length} onClick={() => setModal("delete")}>Delete selected</button></div>}
    {feedback && <p className="account-inline-notice" role="status">{feedback}</p>}
    {passwordError && <p className="account-alert error-alert" role="alert">{passwordError}</p>}
    <div className="account-table-wrap"><table className="account-table"><thead><tr>{!trash && <th aria-label="Select"><input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all accounts" /></th>}<th>Account</th>{!trash && <th>Password</th>}<th>Category</th><th>Tags</th><th>Notes</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>{accounts.map((account) => <tr key={account.id}>{!trash && <td><input type="checkbox" checked={selected.includes(account.id)} onChange={() => toggle(account.id)} aria-label={`Select ${account.username ?? account.displayName}`} /></td>}
        <td><div className="account-identity"><span className="account-avatar">{account.displayName.slice(0, 1).toUpperCase()}</span><span><strong>{account.displayName}</strong><small>{account.code} - {account.username ?? "No mail"}</small></span></div></td>
        {!trash && <td>{account.hasCredentials ? <div className="password-cell"><span>{revealed?.id === account.id ? revealed.password : "••••••••"}</span><button type="button" className="password-toggle" disabled={revealingId === account.id} onClick={() => void togglePassword(account.id)} aria-label={revealed?.id === account.id ? `Hide password for ${account.username ?? account.displayName}` : `Show password for ${account.username ?? account.displayName}`} title={revealed?.id === account.id ? "Hide password" : "Show password"}><svg viewBox="0 0 24 24" aria-hidden="true">{revealed?.id === account.id ? <><path d="M3 3l18 18"/><path d="M10.6 10.6a2 2 0 002.8 2.8"/><path d="M9.9 5.2A11.4 11.4 0 0112 5c5 0 8.5 4.5 9.5 7-.4 1-1.3 2.2-2.5 3.3M6.2 6.2C3.9 7.6 2.8 9.7 2.5 12c1 2.5 4.5 7 9.5 7 1.1 0 2.1-.2 3-.6"/></> : <><path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7z"/><circle cx="12" cy="12" r="3"/></>}</svg></button></div> : <span className="muted-cell">No credential</span>}</td>}
        <td>{account.category ?? <span className="muted-cell">Uncategorized</span>}</td><td><div className="account-tags">{account.tags.length ? account.tags.map((tag) => <span className="account-tag" key={tag}>{tag}</span>) : <span className="muted-cell">-</span>}</div></td>
        <td className="account-note-cell" title={account.notes ?? ""}>{account.notes || <span className="muted-cell">-</span>}</td><td><span className={`account-status status-${account.status.toLowerCase()}`}>{account.status.replaceAll("_", " ")}</span></td>
        <td>{trash ? <form action={restoreAccount}><input type="hidden" name="id" value={account.id} /><button className="text-action" type="submit">Restore</button></form> : <div className="row-actions"><details className="row-menu"><summary>Edit</summary><form action={renameAccount} className="account-edit-form"><input type="hidden" name="id" value={account.id} /><label>Account name<input name="displayName" defaultValue={account.displayName} required maxLength={120} /></label><label>Category<select name="categoryId" defaultValue={account.categoryId ?? ""}><option value="">No category</option>{categories.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>Tags<input name="tags" defaultValue={account.tags.join(", ")} placeholder="Comma-separated tags" /></label><small>Remove a tag from the list or clear it to remove all tags.</small><label>Notes<textarea name="notes" defaultValue={account.notes ?? ""} rows={3} /></label><button className="primary-button" type="submit">Save changes</button></form></details><form action={trashAccount}><input type="hidden" name="id" value={account.id} /><button className="text-action danger-action" type="submit">Move to trash</button></form></div>}</td>
      </tr>)}</tbody></table></div>
    {modal === "login" && <LoginBatch accounts={accounts.filter((account) => selected.includes(account.id)).map(({ id, username, displayName }) => ({ id, label: username ?? displayName }))} onDone={() => { setSelected([]); setModal(null); }} />}
    {modal && modal !== "login" && <div className="account-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeModal(); }}><section className="account-modal" role="dialog" aria-modal="true" aria-labelledby="bulk-modal-title"><button className="modal-close" type="button" onClick={closeModal} aria-label="Close">x</button><p className="eyebrow">{selected.length} SELECTED</p><h3 id="bulk-modal-title">{modal === "category" ? "Add to category" : modal === "tags" ? "Add tags" : modal === "notes" ? "Add notes" : modal === "edit" ? "Bulk edit accounts" : "Delete selected accounts"}</h3>
      {modal === "edit" && <form action={async () => { try { const formData = new FormData(); formData.set("updates", JSON.stringify(editDrafts)); await bulkUpdateAccounts(formData); setFeedback("Selected accounts updated."); setSelected([]); closeModal(); } catch { setFeedback("Could not update selected accounts. Check the fields and try again."); } }}>
        <div className="bulk-edit-list">{editDrafts.map((draft) => <div className="bulk-edit-row" key={draft.id}><strong>{accounts.find((item) => item.id === draft.id)?.username ?? `Account ${draft.id}`}</strong><label>Account name<input value={draft.displayName} onChange={(event) => updateDraft(draft.id, "displayName", event.target.value)} maxLength={120} required /></label><label>Category<select value={draft.categoryId} onChange={(event) => updateDraft(draft.id, "categoryId", event.target.value)}><option value="">No category</option>{categories.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>Tags<input value={draft.tags} onChange={(event) => updateDraft(draft.id, "tags", event.target.value)} placeholder="Comma-separated tags" /></label><small>Remove a tag from the list or clear it to remove all tags.</small><label>Notes<textarea value={draft.notes} onChange={(event) => updateDraft(draft.id, "notes", event.target.value)} rows={2} maxLength={2000} /></label></div>)}</div>
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={closeModal}>Cancel</button><button className="primary-button" type="submit">Save all changes</button></div>
      </form>}
      {modal === "delete" && <form action={async (formData) => { try { selected.forEach((id) => formData.append("ids", String(id))); await bulkTrashAccounts(formData); setFeedback(`Moved ${selected.length} account(s) to Trash. You can restore them later.`); setSelected([]); closeModal(); } catch { setFeedback("Could not move the selected accounts to Trash. Try again."); } }}><p className="bulk-delete-copy">Move {selected.length} selected account(s) to Trash? You can restore them later.</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={closeModal}>Cancel</button><button className="primary-button bulk-delete-confirm" type="submit">Move to Trash</button></div></form>}
      {(modal === "category" || modal === "tags" || modal === "notes") && <form action={async (formData) => { try { await action(formData); setFeedback(`${modal === "category" ? "Category assigned" : modal === "tags" ? "Tags added" : "Notes added"} to selected accounts.`); setSelected([]); closeModal(); } catch { setFeedback("Could not apply this change. Check the values and try again."); } }}>
        {selected.map((id) => <input type="hidden" name="ids" value={id} key={id} />)}
        {modal === "category" && <><label className="modal-field">Category folder<select name="categoryId" value={category} onChange={(event) => { setCategory(event.target.value); setCreateNew(false); }} required={!createNew}><option value="">Choose a category</option>{categories.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><button type="button" className="text-action" onClick={() => { setCreateNew(true); setCategory(""); }}>+ Create new category folder</button>{createNew && <label className="modal-field">New category name<input name="newCategory" autoFocus maxLength={80} required /></label>}<p className="category-move-hint">Each account can be in one category folder. Assigning a category moves selected accounts into it.</p></>}
        {modal === "tags" && <label className="modal-field">Tag names<input name="tags" autoFocus placeholder="e.g. client, urgent" required /><small>Separate multiple tags with commas. Existing tags stay in place.</small></label>}
        {modal === "notes" && <label className="modal-field">Note to add<textarea name="notes" autoFocus rows={4} maxLength={2000} required placeholder="This note will be added after each selected account's existing notes." /><small>Existing notes are kept.</small></label>}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={closeModal}>Cancel</button><button className="primary-button" type="submit">{modal === "category" ? "Assign category" : modal === "tags" ? "Add tags" : "Add notes"}</button></div>
      </form>}
    </section></div>}
  </>;
}
