"use client";

import { useState, useTransition } from "react";
import { populatePageForm } from "./actions";
import { FACEBOOK_PAGE_CATEGORIES } from "@/lib/facebook-page-categories";

type AccountOption = { id: number; label: string };

export default function PageForm({ accounts }: { accounts: AccountOption[] }) {
  const [accountId, setAccountId] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [categoryQuery, setCategoryQuery] = useState("");
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [activeCategoryIndex, setActiveCategoryIndex] = useState(0);
  const [bio, setBio] = useState("");
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);
  const [isPending, startTransition] = useTransition();
  const filteredCategories = FACEBOOK_PAGE_CATEGORIES.filter((option) =>
    option.toLowerCase().includes(categoryQuery.trim().toLowerCase()),
  );

  function chooseCategory(value: string) {
    setCategory(value);
    setCategoryQuery(value);
    setCategoryOpen(false);
    setActiveCategoryIndex(0);
  }

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
      <p>Select one active account and enter details for a single Page. After verifying the populated fields and category selection, the helper clicks Create Page and retries once only if the button remains visible and enabled.</p></div>
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
      <div className="modal-field page-category-field" onBlur={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setCategoryOpen(false);
      }}>
        <label htmlFor="page-category-search">Category</label>
        <div className="page-category-control">
          <input
            id="page-category-search"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={categoryOpen}
            aria-controls="page-category-options"
            aria-activedescendant={categoryOpen && filteredCategories.length ? `page-category-option-${activeCategoryIndex}` : undefined}
            autoComplete="off"
            value={categoryQuery}
            onFocus={() => { setCategoryOpen(true); setActiveCategoryIndex(0); }}
            onChange={(event) => {
              setCategoryQuery(event.target.value);
              setCategory("");
              setCategoryOpen(true);
              setActiveCategoryIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && filteredCategories.length) {
                event.preventDefault();
                setCategoryOpen(true);
                setActiveCategoryIndex((index) => (index + 1) % filteredCategories.length);
              } else if (event.key === "ArrowUp" && filteredCategories.length) {
                event.preventDefault();
                setCategoryOpen(true);
                setActiveCategoryIndex((index) => (index - 1 + filteredCategories.length) % filteredCategories.length);
              } else if (event.key === "Enter" && categoryOpen && filteredCategories.length) {
                event.preventDefault();
                chooseCategory(filteredCategories[activeCategoryIndex] ?? filteredCategories[0]);
              } else if (event.key === "Escape") {
                setCategoryOpen(false);
              }
            }}
            placeholder="Search categories…"
            disabled={isPending}
          />
          {categoryOpen && !isPending && <ul className="page-category-options" id="page-category-options" role="listbox" aria-label="Page categories">
            {filteredCategories.length ? filteredCategories.map((option, index) => <li
              id={`page-category-option-${index}`}
              role="option"
              aria-selected={category === option}
              className={index === activeCategoryIndex ? "active" : ""}
              key={option}
              onMouseEnter={() => setActiveCategoryIndex(index)}
            ><button type="button" tabIndex={-1} onMouseDown={(event) => event.preventDefault()} onClick={() => chooseCategory(option)}>{option}</button></li>) :
              <li className="page-category-empty" role="presentation">No matching categories</li>}
          </ul>}
        </div>
        <small>{category ? `Selected: ${category}` : `${FACEBOOK_PAGE_CATEGORIES.length} categories · choose a suggestion to select it`}</small>
      </div>
      <label className="modal-field">Bio
        <textarea value={bio} onChange={(event) => setBio(event.target.value)} maxLength={500} rows={4} required disabled={isPending} />
      </label>
      <p className="page-form-note">Choose a category from the searchable list. Facebook may require additional information or confirmation. The helper never retries an uncertain click; check the Cent window before running it again.</p>
      <div className="page-form-actions"><button className="primary-button" type="button" onClick={populate} disabled={isPending || !accountId || !name.trim() || !category || !bio.trim()}>{isPending ? "Populating and creating…" : "Populate fields and click Create Page"}</button></div>
    </>}
    {message && <p className={`account-alert ${isError ? "error-alert" : "success-alert"}`} role={isError ? "alert" : "status"}>{message}</p>}
  </section>;
}
