"use client";

import { useEffect } from "react";
import { logError } from "@/lib/logger";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    logError("route_render_failed", error, { digest: error.digest });
  }, [error]);

  return (
    <main className="message-page">
      <section className="message-card">
        <p className="eyebrow">SOMETHING WENT WRONG</p>
        <h1>This view could not load</h1>
        <p>The error has been recorded. You can try loading this view again.</p>
        <button onClick={() => reset()}>Try again</button>
      </section>
    </main>
  );
}
