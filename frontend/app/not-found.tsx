import Link from "next/link";

export default function NotFound() {
  return (
    <main className="message-page">
      <section className="message-card">
        <p className="eyebrow">404 · NOT FOUND</p>
        <h1>This page isn’t here</h1>
        <p>The address may be outdated or the page may not exist yet.</p>
        <Link href="/">Return to workspace</Link>
      </section>
    </main>
  );
}
