"use client";

import { useEffect } from "react";
import { logError } from "@/lib/logger";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    logError("root_render_failed", error, { digest: error.digest });
  }, [error]);

  return (
    <html lang="en">
      <body>
        <main className="message-page">
          <section className="message-card">
            <p className="eyebrow">APPLICATION ERROR</p>
            <h1>KartStudio could not start</h1>
            <p>An unexpected error occurred. Try loading the workspace again.</p>
            <button onClick={() => reset()}>Try again</button>
          </section>
        </main>
      </body>
    </html>
  );
}
