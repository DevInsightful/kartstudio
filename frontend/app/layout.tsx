import type { Metadata } from "next";
import { WorkspaceShell } from "./_components/workspace-shell";
import { getCurrentUser } from "@/lib/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "KartStudio | Automation Workspace",
    template: "%s | KartStudio",
  },
  description: "A workspace for preparing and monitoring browser automation workflows.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const user = await getCurrentUser();
  return (
    <html lang="en">
      <body><WorkspaceShell user={user}>{children}</WorkspaceShell></body>
    </html>
  );
}
