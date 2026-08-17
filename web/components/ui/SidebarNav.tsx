"use client";

import { usePathname } from "next/navigation";

export type SidebarLink = { href: string; label: string; icon: keyof typeof ICONS };

// One line-icon per section — small, consistent stroke weight, no icon
// library dependency for ten glyphs. Matches the admin-shell convention
// (Shopify Admin, Looker, etc.) of a recognizable glyph next to every nav
// label rather than text alone.
const ICONS = {
  network: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 17l5-6 4 3 8-9"/><path d="M3 20h18"/></svg>
  ),
  stock: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M21 8l-9-5-9 5 9 5 9-5Z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></svg>
  ),
  replenishment: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 4v5h5"/><path d="M20 20v-5h-5"/><path d="M4.6 15a8 8 0 0 0 14.4 2.5M19.4 9A8 8 0 0 0 5 6.5"/></svg>
  ),
  mix: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 4h6l-4 8H2l4-8Z"/><path d="M14 4h6l-4 8h-6l4-8Z"/><path d="M9 20h9"/></svg>
  ),
  footfall: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="9" cy="7" r="3"/><path d="M2 20c0-3.3 3.1-6 7-6s7 2.7 7 6"/><circle cx="18" cy="8" r="2.3"/><path d="M22 20c0-2.6-1.9-4.7-4.5-5.4"/></svg>
  ),
  targets: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="0.5" fill="currentColor"/></svg>
  ),
  users: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="9" cy="7" r="3.2"/><path d="M2.5 20c0-3.6 2.9-6.5 6.5-6.5s6.5 2.9 6.5 6.5"/><path d="M16 4.3a3.2 3.2 0 0 1 0 6M22 20c0-2.8-2-5.1-4.7-5.9"/></svg>
  ),
  integrations: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4"/><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>
  ),
  upload: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 3v12M7 8l5-5 5 5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
  ),
  workspace: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="4" width="7" height="7" rx="1"/><rect x="14" y="4" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="6" rx="1"/><rect x="14" y="14" width="7" height="6" rx="1"/></svg>
  ),
  configurations: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="3"/><path d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.5-2-3.5-2.4.7a7.7 7.7 0 0 0-1.7-1L14.9 3h-4l-.4 2.7a7.7 7.7 0 0 0-1.7 1l-2.4-.7-2 3.5L6.4 11a7.6 7.6 0 0 0 0 2l-2 1.5 2 3.5 2.4-.7c.5.4 1.1.75 1.7 1l.4 2.7h4l.4-2.7c.6-.25 1.2-.6 1.7-1l2.4.7 2-3.5-2-1.5Z"/></svg>
  ),
};

export function SidebarNav({ links }: { links: SidebarLink[] }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-0.5 px-2">
      {links.map((l) => {
        const active = pathname === l.href;
        return (
          <a
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-[13.5px] font-medium transition-colors ${
              active
                ? "bg-sidebar-active-bg text-sidebar-ink-active shadow-sm"
                : "text-sidebar-ink hover:bg-surface-2 hover:text-ink"
            }`}
          >
            <span className={`h-[18px] w-[18px] shrink-0 ${active ? "text-sidebar-ink-active" : "text-ink-3"}`}>
              {ICONS[l.icon]}
            </span>
            {l.label}
          </a>
        );
      })}
    </nav>
  );
}
