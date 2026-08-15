import type { AppRole, PageKey } from "@/lib/auth/roles";
import { SignOutButton } from "./SignOutButton";
import { ThemeToggle } from "./ThemeToggle";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { getLang } from "@/lib/i18n/server";
import { DICTIONARIES, type Dict } from "@/lib/i18n/translations";
import { createClient } from "@/lib/data/client";

type NavLink = { href: string; labelKey: keyof Dict; roles: AppRole[] };

// Maps a NAV_LINKS href to the PageKey core.user_page_overrides rows key on
// (see lib/auth/roles.ts requirePageAccess) — only links with an entry here
// get a per-user override applied; the two commented-out links below
// (my-store, campaigns) intentionally have none.
const HREF_PAGE_KEY: Record<string, PageKey> = {
  "/network": "network",
  "/stock-details": "stock-details",
  "/replenishment": "replenishment",
  "/footfall": "footfall",
  "/targets": "targets",
  "/users": "users",
  "/integrations": "integrations",
  "/data-upload": "data-upload",
};

// Single source of truth for "who can see which section" in the nav. Every
// layout previously hand-rolled its own header with no links to the OTHER
// sections that role can reach — e.g. super_admin landed on /users with no
// way to click through to /network at all. Add a new top-level page's link
// here once, and every role that should see it does, everywhere.
const NAV_LINKS: NavLink[] = [
  {
    href: "/network",
    labelKey: "navNetwork",
    roles: ["ho_admin", "regional_manager", "super_admin", "ebo_manager", "marketing"],
  },
  {
    href: "/stock-details",
    labelKey: "navStockDetails",
    // Widened alongside (stock-details)/layout.tsx: base display capacity
    // (migration 0026) is view-only for these roles, edit-only for
    // ho_admin/super_admin.
    roles: ["ho_admin", "regional_manager", "super_admin", "ebo_manager", "marketing"],
  },
  {
    href: "/replenishment",
    labelKey: "navReplenishment",
    roles: ["ho_admin", "regional_manager", "super_admin", "ebo_manager", "marketing"],
  },
  {
    href: "/sale-stock-mix",
    labelKey: "navSaleStockMix",
    // Same route group/gate as Replenishment (both live under
    // (replenishment)/, single "replenishment" pageKey) — same role list.
    roles: ["ho_admin", "regional_manager", "super_admin", "ebo_manager", "marketing"],
  },
  { href: "/footfall", labelKey: "navFootfall", roles: ["ebo_manager", "ho_admin", "super_admin"] },
  { href: "/targets", labelKey: "navTargets", roles: ["ho_admin", "super_admin"] },
  { href: "/users", labelKey: "navUsers", roles: ["super_admin"] },
  { href: "/integrations", labelKey: "navIntegrations", roles: ["super_admin"] },
  { href: "/data-upload", labelKey: "navDataUpload", roles: ["ho_admin", "super_admin"] },
  // Hidden for now at the user's request — both are still placeholder
  // screens. The routes themselves still exist and remain reachable by
  // direct URL; only the nav entries are removed. Restore by uncommenting.
  // { href: "/my-store", labelKey: "navMyStore", roles: ["ebo_manager", "ho_admin", "super_admin"] },
  // { href: "/campaigns", labelKey: "navCampaigns", roles: ["marketing", "ho_admin", "super_admin"] },
];

export async function TopNav({
  title,
  role,
  fullName,
  userId,
}: {
  title?: string;
  role: AppRole;
  fullName: string;
  // Optional so any caller that hasn't been updated yet still compiles —
  // without it, links fall back to the plain role check (pre-existing
  // behavior). Every current layout.tsx passes it (see users/actions.ts
  // header comment on why per-user overrides live in core.user_page_overrides).
  userId?: string;
}) {
  const lang = await getLang();
  const t = DICTIONARIES[lang];

  // Per-user page overrides (migration 0035) layered on top of the plain
  // role check — same "override row wins either direction, missing row
  // defers to role default" rule as requirePageAccess() in lib/auth/roles.ts.
  // Read-your-own-overrides is covered by user_page_overrides_self_read, so
  // this works under the caller's own session (no admin client needed).
  let overrideMap = new Map<PageKey, boolean>();
  if (userId) {
    const supabase = await createClient();
    const { data: overrides } = await supabase
      .schema("core")
      .from<{ page_key: PageKey; allowed: boolean }>("user_page_overrides")
      .select("page_key, allowed")
      .eq("user_id", userId);
    overrideMap = new Map((overrides ?? []).map((o) => [o.page_key, o.allowed]));
  }

  const links = NAV_LINKS.filter((l) => {
    const pageKey = HREF_PAGE_KEY[l.href];
    if (pageKey && overrideMap.has(pageKey)) return overrideMap.get(pageKey)!;
    return l.roles.includes(role);
  });

  return (
    // sticky + top-0: keeps the nav visible while page content scrolls,
    // instead of it scrolling out of view like every other element. bg-ground
    // (not transparent) so scrolled-under content doesn't show through, and
    // z-40 keeps it above page content but below the top progress bar
    // (TopProgressBar, z-[100]) which briefly overlaps its top edge while a
    // navigation/action is in flight.
    <header className="sticky top-0 z-40 flex flex-wrap items-center justify-between gap-3 border-b border-line bg-ground py-4 text-sm text-ink-2">
      <div className="flex flex-wrap items-center gap-6">
        <a href="/network" className="font-serif text-lg text-ink hover:text-ink-2">
          {title ?? t.appName}
        </a>
        <nav className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
          {links.map((l) => (
            // -my-2 py-2 grows the tap target to ~36px tall without pushing
            // the nav row itself taller — same trick as SignOutButton.
            <a key={l.href} href={l.href} className="-my-2 py-2 hover:text-ink">
              {t[l.labelKey]}
            </a>
          ))}
        </nav>
      </div>
      <span className="flex items-center gap-3">
        <span className="hidden sm:inline">
          {fullName} · {role}
        </span>
        <LanguageSwitcher current={lang} />
        <ThemeToggle />
        <SignOutButton label={t.signOut} />
      </span>
    </header>
  );
}
