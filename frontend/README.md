KartStudio is a Next.js App Router workspace for a browser automation product. The current build establishes the project foundation; feature modules will be added incrementally and tracked in `../kartstudio_progress_tracker.md`.

## Getting Started

First, run the development server:

```bash
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
