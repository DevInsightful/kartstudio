"use client";

import { useState } from "react";

type PasswordFieldProps = {
  name: string;
  label: string;
  autoComplete?: string;
  minLength?: number;
  required?: boolean;
  placeholder?: string;
  compact?: boolean;
};

export function PasswordField({ name, label, autoComplete = "new-password", minLength, required = false, placeholder, compact = false }: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  return <label className={`password-field${compact ? " password-field-compact" : ""}`}>
    <span className={compact ? "visually-hidden" : ""}>{label}</span>
    <span className="password-input-wrap"><input name={name} type={visible ? "text" : "password"} autoComplete={autoComplete} minLength={minLength} required={required} placeholder={placeholder} aria-label={compact ? label : undefined} /><button type="button" onClick={() => setVisible((value) => !value)} aria-label={`${visible ? "Hide" : "Show"} ${label.toLocaleLowerCase()}`}>{visible ? "Hide" : "Show"}</button></span>
  </label>;
}
