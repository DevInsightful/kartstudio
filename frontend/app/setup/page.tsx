import { redirect } from "next/navigation";
import { setupAdminAction } from "@/app/auth-actions";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PasswordField } from "@/app/_components/password-field";

export default async function SetupPage({ searchParams }: PageProps<"/setup">) {
  if (await getCurrentUser()) redirect("/");
  if (await prisma.user.count()) redirect("/login");
  const { error } = await searchParams;
  const errorCode = Array.isArray(error) ? error[0] : error;
  const messages: Record<string, string> = {
    username: "Use 3–40 letters, numbers, dots, underscores, or hyphens for the username.",
    email: "Enter a valid email address.",
    duplicate: "That username or email is already in use, or setup has already been completed.",
  };
  return <section className="auth-card"><p className="eyebrow">KARTAR · FIRST-TIME SETUP</p><h2>Create the platform administrator</h2><p>This first account can create users and view the platform user list. Each user gets a separate workspace.</p>
    {errorCode && <p className="account-alert error-alert" role="alert">{messages[errorCode] ?? "Setup could not be completed."}</p>}
    <form action={setupAdminAction} className="auth-form"><label>Admin username<input name="username" autoComplete="username" minLength={3} maxLength={40} required /></label><label>Email <span className="field-optional">optional</span><input name="email" type="email" autoComplete="email" /></label><PasswordField name="password" label="Password" minLength={10} required /><small>Use at least 10 characters. The password is stored as a one-way hash.</small><button className="primary-button" type="submit">Create administrator</button></form>
  </section>;
}
