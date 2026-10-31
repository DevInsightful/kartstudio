import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { loginAction } from "@/app/auth-actions";
import { PasswordField } from "@/app/_components/password-field";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  if (await getCurrentUser()) redirect("/");
  const { error } = await searchParams;
  const hasUsers = await prisma.user.count() > 0;
  if (!hasUsers) redirect("/setup");
  return <section className="auth-card"><p className="eyebrow">KARTAR · SIGN IN</p><h2>Welcome back</h2><p>Sign in to open your private workspace.</p>
    {error === "invalid" && <p className="account-alert error-alert" role="alert">Username, email, or password is incorrect.</p>}
    <form action={loginAction} className="auth-form"><label>Username or email<input name="identifier" autoComplete="username" required /></label><PasswordField name="password" label="Password" autoComplete="current-password" required /><button className="primary-button" type="submit">Sign in</button></form>
    <small>Ask your platform administrator to create an account if you don’t have one.</small>
    <Link href="/setup">First-time platform setup</Link>
  </section>;
}
