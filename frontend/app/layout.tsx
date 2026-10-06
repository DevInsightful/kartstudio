import type { Metadata } from "next";
import { WorkspaceShell } from "./_components/workspace-shell";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "KartStudio | Automation Workspace",
    template: "%s | KartStudio",
  },
  description: "A workspace for preparing and monitoring browser automation workflows.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body><WorkspaceShell>{children}</WorkspaceShell></body>
    </html>
  );
}
