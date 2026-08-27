"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { SidebarLink } from "./SidebarNav";

/**
 * The `md:hidden` nav row, split out of AppShell.tsx (a Server Component) so
 * it can read `usePathname()` and mark the active link with `aria-current`,
 * matching what SidebarNav already does on desktop.
 *
 * Height is deliberately FIXED (`h-10`) and the row scrolls horizontally
 * instead of wrapping. Previously it was `flex-wrap`, so with ten links it
 * wrapped to two or three lines on a phone while the content area's top
 * padding was a fixed `pt-14` sized for the top bar alone — the first lines
 * of every page rendered underneath the nav. A wrapping row has no height
 * the layout can compensate for (it depends on link count, label length and
 * viewport width); a single non-wrapping scrollable row does, so the content
 * offset in AppShell (`pt-24`, i.e. 56px top bar + 40px nav) is now exact.
 * A hamburger drawer is the fuller answer, but this fixes the overlap.
 */
export function MobileNav({ links }: { links: SidebarLink[] }) {
  const pathname = usePathname();

  return (
    <nav className="fixed inset-x-0 top-14 z-40 flex h-10 items-center gap-x-4 overflow-x-auto whitespace-nowrap border-b border-line-soft bg-sidebar-bg px-4 text-[12.5px] text-ink-2 md:hidden">
      {links.map((l) => {
        const active = pathname === l.href;
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            className={`shrink-0 ${active ? "font-semibold text-ink" : "hover:text-ink"}`}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
