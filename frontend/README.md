KartStudio is a Next.js App Router workspace for a browser automation product. Its account store uses a SQLite file on this PC; the dev and production servers bind to `127.0.0.1` so the local account UI is not exposed to the LAN by default. Feature modules are added incrementally and tracked in `../kartstudio_progress_tracker.md`.

## Getting Started

First, run the development server:

```bash
npm run db:migrate -- --name account_foundation
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

The dashboard shell is in `app/page.tsx`. Shared styling is in `app/globals.css`. Route and root-level error boundaries are in `app/error.tsx` and `app/global-error.tsx`. Structured application logging helpers live in `lib/logger.ts`.

The local database file is `data/kartstudio.db` and is ignored by Git. The Accounts screen imports CSV, TXT, and XLSX files with `mail` and `password` columns. Passwords are stored as plain text in this local SQLite database and are masked in the table until revealed with the per-account eye toggle. Use **Import accounts** to view and download example templates. Categories act as in-app account folders; each account can belong to one category at a time. Select account rows to bulk edit names, categories, tags, and notes, move them to Trash, append tags, or append notes. Use a row's **Edit** menu to edit or clear that account's category, tags, and notes.

Each account row shows **Open profile** when its system status is `ACTIVE` and **Login** otherwise. The selected-account flow also opens accounts in batches. Both use the same persistent Cent profile under `data/browser-profiles/`: Facebook's home page is opened first, an existing authenticated session is reused, and saved credentials are populated and submitted only if Facebook presents its login form. After submission, the app waits for Facebook's page to show an authenticated session, a login form/checkpoint, or an inconclusive state, then automatically records the result as `ACTIVE`, `LOGIN_REQUIRED`, or `UNKNOWN`. It does not export or separately copy cookies; Cent retains its cookies and site data across normal browser closes. The page-state check is based on Facebook's rendered response rather than the presence of a cookie alone. Facebook checkpoints and 2FA prompts must still be completed manually. If Cent was closed manually but its profile still shows as open, use the reset-and-retry control in the batch dialog. The launcher tiles batch windows across the primary Windows display. Configure `KARTSTUDIO_CENT_BROWSER_PATH` in `.env.local` if Cent is not in a detected install folder, then restart Next.js. Prisma schema and migration files are under `prisma/`.

Copy `.env.example` to `.env.local` when local configuration is needed. Keep secrets in server-only environment variables; never expose credentials through `NEXT_PUBLIC_*` variables.

The source build plan recommends Electron for a desktop product, while this project is currently a Next.js app. The Next.js app is the selected foundation for this implementation; browser automation runtime and deployment constraints must be designed explicitly before adding browser workers.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
