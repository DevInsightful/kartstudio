import { changeOwnPasswordAction } from "@/app/auth-actions";
import { PasswordField } from "@/app/_components/password-field";

export default async function SettingsPage({ searchParams }: PageProps<"/settings">) {
  const { error, changed } = await searchParams;
  return <div className="section-page"><section className="section-intro"><p className="eyebrow">SETTINGS</p><h2>Account and workspace</h2><p>Manage your sign-in password and workspace preferences.</p></section>
    {changed && <p className="account-alert success-alert" role="status">Your password was changed. Other sessions have been signed out.</p>}
    {error && <p className="account-alert error-alert" role="alert">{error === "current-password" ? "The current password is incorrect." : "The new password must be between 10 and 256 characters."}</p>}
    <section className="page-form-panel"><div className="page-form-heading"><div><p className="eyebrow">SECURITY</p><h3>Change password</h3><p>Your password is stored as a one-way hash. Platform admins cannot view it.</p></div></div>
      <form action={changeOwnPasswordAction} className="auth-form admin-user-form"><PasswordField name="currentPassword" label="Current password" autoComplete="current-password" required /><PasswordField name="newPassword" label="New password" minLength={10} required /><button className="primary-button" type="submit">Change password</button></form>
    </section>
  </div>;
}
