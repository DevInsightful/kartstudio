"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";

const navigation = [
  {
    heading: "Workspace",
    items: [{ label: "Dashboard", href: "/", mark: "DB" }],
  },
  {
    heading: "Manage",
    items: [
      { label: "Accounts", href: "/accounts", mark: "AC" },
      { label: "Pages", href: "/pages", mark: "PG" },
      { label: "Groups", href: "/groups", mark: "GR" },
      { label: "Campaigns", href: "/campaigns", mark: "CA" },
    ],
  },
  {
    heading: "Content",
    items: [
      { label: "Library", href: "/content/library", mark: "LI" },
      { label: "Categories", href: "/content/categories", mark: "CT" },
      { label: "Presets", href: "/content/presets", mark: "PR" },
    ],
  },
  {
    heading: "Publishing",
    items: [
      { label: "Calendar", href: "/publishing/calendar", mark: "CL" },
      { label: "Scheduled", href: "/publishing/scheduled", mark: "SC" },
      { label: "Published", href: "/publishing/published", mark: "PB" },
    ],
  },
  {
    heading: "Automation",
    items: [
      { label: "Jobs", href: "/automation/jobs", mark: "JB" },
      { label: "Activity", href: "/automation/activity", mark: "AT" },
    ],
  },
  {
    heading: "Preferences",
    items: [{ label: "Settings", href: "/settings", mark: "ST" }],
  },
];

const pageTitles = navigation.flatMap((group) => group.items);

export function WorkspaceShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [openPanel, setOpenPanel] = useState<"notifications" | "profile" | null>(null);
  const currentPage = pageTitles.find((item) => item.href === pathname) ?? pageTitles[0];
  const pathParts = pathname.split("/").filter(Boolean);
  const parentLabel = pathParts.length > 1
    ? navigation.find((group) => group.items.some((item) => item.href.startsWith(`/${pathParts[0]}/`)))?.heading
    : "Workspace";

  function togglePanel(panel: "notifications" | "profile") {
    setOpenPanel((current) => current === panel ? null : panel);
  }

  return (
    <div className={`app-frame${collapsed ? " is-collapsed" : ""}`}>
      {mobileOpen && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
      <aside className={`sidebar${mobileOpen ? " mobile-open" : ""}`} aria-label="Main navigation">
        <Link className="sidebar-brand" href="/" onClick={() => setMobileOpen(false)}>
          <span className="brand-mark" aria-hidden="true">K</span>
          <span className="brand-name">KartStudio</span>
        </Link>
        <nav className="nav-scroll" aria-label="Workspace sections">
          {navigation.map((group) => (
            <div className="nav-group" key={group.heading}>
              <p className="nav-heading">{group.heading}</p>
              {group.items.map((item) => {
                const active = pathname === item.href || (item.href !== "/" && pathname.startsWith(`${item.href}/`));
                return (
                  <Link
                    className={`nav-link${active ? " is-active" : ""}`}
                    href={item.href}
                    key={item.href}
                    aria-current={active ? "page" : undefined}
                    title={collapsed ? item.label : undefined}
                    onClick={() => setMobileOpen(false)}
                  >
                    <span className="nav-mark" aria-hidden="true">{item.mark}</span>
                    <span className="nav-label">{item.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <button
          className="collapse-button"
          onClick={() => setCollapsed((value) => !value)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <span aria-hidden="true">{collapsed ? "›" : "‹"}</span>
          <span className="nav-label">Collapse sidebar</span>
        </button>
      </aside>

      <div className="workspace-column">
        <header className="workspace-header">
          <button className="mobile-menu-button" aria-label="Open navigation" onClick={() => setMobileOpen(true)}>☰</button>
          <div className="header-title-block">
            <div className="breadcrumbs" aria-label="Breadcrumb">
              <span>{parentLabel}</span><span className="breadcrumb-divider">/</span><span aria-current="page">{currentPage.label}</span>
            </div>
            <h1 className="header-title">{currentPage.label}</h1>
          </div>
          <div className="header-actions">
            <div className="popover-anchor">
              <button className={`header-icon-button${openPanel === "notifications" ? " selected" : ""}`} aria-label="Notifications" aria-expanded={openPanel === "notifications"} onClick={() => togglePanel("notifications")}>
                <span aria-hidden="true">♧</span><span className="notification-dot" />
              </button>
              {openPanel === "notifications" && <div className="header-popover"><strong>Notifications</strong><p>You’re all caught up.</p></div>}
            </div>
            <span className="header-divider" />
            <div className="popover-anchor">
              <button className="profile-button" aria-label="Application menu" aria-expanded={openPanel === "profile"} onClick={() => togglePanel("profile")}>
                <span className="avatar">KS</span><span className="profile-label">Workspace</span><span className="profile-chevron">⌄</span>
              </button>
              {openPanel === "profile" && <div className="header-popover profile-popover"><strong>KartStudio</strong><p>Local workspace</p><Link href="/settings" onClick={() => setOpenPanel(null)}>Workspace settings</Link></div>}
            </div>
          </div>
        </header>
        <main className="workspace-main">{children}</main>
      </div>
    </div>
  );
}
