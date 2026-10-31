import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createUserAction, resetUserPasswordAction } from "./actions";
import { PasswordField } from "@/app/_components/password-field";

export default async function PlatformUsersPage({ searchParams }: PageProps<"/admin/users">) {
  await requireAdmin();
  const [{ error, created, reset }, users] = await Promise.all([
    searchParams,
    prisma.user.findMany({ select: { id: true, username: true, email: true, role: true, createdAt: true }, orderBy: { createdAt: "asc" } }),
  ]);
  const errorCode = Array.isArray(error) ? error[0] : error;
  const errors: Record<string, string> = {
    username: "Use 3–40 letters, numbers, dots, underscores, or hyphens for the username.",
    email: "Enter a valid email address.",
    duplicate: "That username or email is already registered.",
    password: "Passwords must be between 10 and 256 characters.",
    missing: "That user could not be found.",
  };
  return <div className="section-page">
    <section className="section-intro"><p className="eyebrow">PLATFORM ADMINISTRATION</p><h2>Users</h2><p>{users.length} registered user{users.length === 1 ? "" : "s"}. Each user has an isolated workspace.</p></section>
    {created && <p className="account-alert success-alert" role="status">User created. Share the username, email, and initial password with them securely.</p>}
    {reset && <p className="account-alert success-alert" role="status">Password reset. The user has been signed out of their existing sessions.</p>}
    {errorCode && <p className="account-alert error-alert" role="alert">{errors[errorCode] ?? "The request could not be completed."}</p>}
    <section className="page-form-panel"><div className="page-form-heading"><div><p className="eyebrow">NEW USER</p><h3>Create a user account</h3><p>Set an initial password. You will not be able to view it again; users can change it after signing in.</p></div></div>
      <form action={createUserAction} className="auth-form admin-user-form"><label>Username<input name="username" minLength={3} maxLength={40} autoComplete="off" required /></label><label>Email <span className="field-optional">optional</span><input name="email" type="email" autoComplete="off" /></label><PasswordField name="password" label="Initial password" minLength={10} required /><button className="primary-button" type="submit">Create user</button></form>
    </section>
    <section className="page-form-panel"><div className="page-form-heading"><div><p className="eyebrow">REGISTERED USERS</p><h3>All users</h3></div></div>
      <div className="platform-user-table-wrap"><table className="platform-user-table"><thead><tr><th>Username</th><th>Email</th><th>Role</th><th>Joined</th><th>Reset password</th></tr></thead><tbody>{users.map((user) => <tr key={user.id}><td>{user.username}</td><td>{user.email || "—"}</td><td>{user.role === "ADMIN" ? "Admin" : "User"}</td><td>{user.createdAt.toLocaleDateString()}</td><td><form action={resetUserPasswordAction} className="inline-reset-form"><input type="hidden" name="userId" value={user.id} /><PasswordField name="password" label={`New password for ${user.username}`} minLength={10} required compact placeholder="New password" /><button type="submit" className="secondary-button">Reset</button></form></td></tr>)}</tbody></table></div>
      <p className="professional-upload-note">Show/Hide applies to the password entered here. Existing passwords are one-way hashed and cannot be revealed. Resetting a password signs that user out of all sessions.</p>
    </section>
  </div>;
}
