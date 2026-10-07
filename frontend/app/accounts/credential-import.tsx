"use client";
import { useState } from "react";

export default function CredentialImport() {
  const [format, setFormat] = useState<"csv" | "txt" | "xlsx">("csv");
  return <section className="account-import-panel"><div className="import-panel-heading"><div><p className="eyebrow">IMPORT ACCOUNTS</p><h3>Import account file</h3><p>Start with a file containing mail and password. Add categories, tags, and notes after import.</p></div></div><details className="import-disclosure"><summary className="primary-button">Import accounts</summary>
    <div className="import-workflow"><div className="import-format-picker" role="group" aria-label="Choose example format">{(["csv", "txt", "xlsx"] as const).map((item) => <button key={item} type="button" className={format === item ? "selected" : ""} onClick={() => setFormat(item)}>{item === "xlsx" ? "Excel (.xlsx)" : item.toUpperCase()}</button>)}</div>
      <div className="import-example"><div><strong>Example {format === "xlsx" ? "Excel workbook" : format.toUpperCase()} format</strong><a href={`/accounts/import-template?format=${format}`} download>Download example</a></div><pre>{format === "csv" ? "mail,password\nname@example.com,replace-with-password" : format === "txt" ? "mail\tpassword\nname@example.com\treplace-with-password" : "Excel sheet: first row has mail | password\nname@example.com | replace-with-password"}</pre><small>Replace the sample values with your own. Passwords are never shown in the account table.</small></div>
      <form action="/accounts/import" method="post" encType="multipart/form-data"><input type="file" name="file" accept=".csv,.txt,.xlsx,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required aria-label="Choose credential file" /><button className="primary-button" type="submit">Choose file and import</button></form>
    </div></details>
  </section>;
}
