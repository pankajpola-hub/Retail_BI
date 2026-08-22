import type { AppRole, BusinessUnit, PageKey } from "@/lib/auth/roles";
import { PAGE_BUSINESS_UNIT } from "@/lib/auth/roles";
import { SidebarNav, type SidebarLink } from "./SidebarNav";
import { SignOutButton } from "./SignOutButton";
import { ThemeToggle } from "./ThemeToggle";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { getLang } from "@/lib/i18n/server";
import { DICTIONARIES, type Dict } from "@/lib/i18n/translations";
import { createClient } from "@/lib/data/client";

/**
 * Shopify Admin-style shell (2026-08-15 redesign, replacing the horizontal
 * TopNav) — a black top bar (brandmark, user identity) with a white sidebar
 * fixed below it, rounded active-item pill, main content on a light-gray
 * ground with white cards. Every route group's layout.tsx renders this
 * once; swapping it in re-themes the whole app from a single file.
 *
 * Auth/override logic (role gating, core.user_page_overrides) is copied
 * verbatim from the old TopNav.tsx — only the rendering shape changed, not
 * which links a role sees.
 *
 * No search box in the top bar, unlike the Shopify reference — this app has
 * no search index/backend behind one, and a decorative input that does
 * nothing would be a worse "missing feature" than not having it at all.
 */
const HREF_PAGE_KEY: Record<string, PageKey> = {
  "/network": "network",
  "/stock-details": "stock-details",
  "/replenishment": "replenishment",
  "/footfall": "footfall",
  "/targets": "targets",
  "/users": "users",
  "/integrations": "integrations",
  "/data-upload": "data-upload",
  "/workspace": "workspace",
  "/configurations": "configurations",
  "/ecomm": "ecomm",
};

type NavLink = { href: string; labelKey: keyof Dict; icon: SidebarLink["icon"]; roles: AppRole[] };

const NAV_LINKS: NavLink[] = [
  { href: "/network", labelKey: "navNetwork", icon: "network", roles: ["ho_admin", "regional_manager", "super_admin", "ebo_manager", "marketing"] },
  { href: "/stock-details", labelKey: "navStockDetails", icon: "stock", roles: ["ho_admin", "regional_manager", "super_admin", "ebo_manager", "marketing"] },
  { href: "/replenishment", labelKey: "navReplenishment", icon: "replenishment", roles: ["ho_admin", "regional_manager", "super_admin", "ebo_manager", "marketing"] },
  { href: "/sale-stock-mix", labelKey: "navSaleStockMix", icon: "mix", roles: ["ho_admin", "regional_manager", "super_admin", "ebo_manager", "marketing"] },
  { href: "/footfall", labelKey: "navFootfall", icon: "footfall", roles: ["ebo_manager", "ho_admin", "super_admin"] },
  { href: "/targets", labelKey: "navTargets", icon: "targets", roles: ["ho_admin", "super_admin"] },
  { href: "/workspace", labelKey: "navWorkspace", icon: "workspace", roles: ["ho_admin", "regional_manager", "super_admin", "ebo_manager", "marketing"] },
  { href: "/users", labelKey: "navUsers", icon: "users", roles: ["super_admin"] },
  { href: "/integrations", labelKey: "navIntegrations", icon: "integrations", roles: ["super_admin"] },
  { href: "/data-upload", labelKey: "navDataUpload", icon: "upload", roles: ["ho_admin", "super_admin"] },
  { href: "/configurations", labelKey: "navConfigurations", icon: "configurations", roles: ["super_admin"] },
  { href: "/ecomm", labelKey: "navEcomm", icon: "ecomm", roles: ["ho_admin", "super_admin"] },
];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

// Deterministic color from the name, so the same person always gets the
// same badge color across sessions instead of a random one on every render.
const AVATAR_HUES = [162, 265, 340, 25, 205];
function avatarHue(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_HUES[hash % AVATAR_HUES.length]!;
}

export async function AppShell({
  role,
  fullName,
  userId,
  businessUnits,
  children,
}: {
  role: AppRole;
  fullName: string;
  userId?: string;
  businessUnits: BusinessUnit[];
  children: React.ReactNode;
}) {
  const lang = await getLang();
  const t = DICTIONARIES[lang];

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

  const links: SidebarLink[] = NAV_LINKS.filter((l) => {
    const pageKey = HREF_PAGE_KEY[l.href];
    // Business unit gates first — same "which business at all, before role/
    // override even apply" ordering as requirePageAccess() in
    // lib/auth/roles.ts. /sale-stock-mix has no PAGE_KEY entry (pre-existing
    // gap, not introduced here) so it skips this check same as it already
    // skipped the override check below.
    if (pageKey && !businessUnits.includes(PAGE_BUSINESS_UNIT[pageKey])) return false;
    if (pageKey && overrideMap.has(pageKey)) return overrideMap.get(pageKey)!;
    return l.roles.includes(role);
  }).map((l) => ({ href: l.href, label: t[l.labelKey], icon: l.icon }));

  const hue = avatarHue(fullName);

  return (
    <div className="min-h-screen bg-ground">
      {/* Top bar — fixed, full width, above both sidebar and content. */}
      <header className="fixed inset-x-0 top-0 z-50 flex h-14 items-center justify-between gap-4 bg-topbar-bg px-4">
        <a href="/network" className="flex shrink-0 items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-[13px] font-bold text-white">
            E
          </span>
          <span className="hidden truncate text-[14.5px] font-semibold text-white sm:inline">{t.appName}</span>
        </a>

        <span className="flex items-center gap-3">
          <span className="hidden items-center gap-2 rounded-full bg-white/10 py-1 pl-1 pr-3 sm:flex">
            <span
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10.5px] font-bold text-white"
              style={{ backgroundColor: `hsl(${hue} 55% 42%)` }}
            >
              {initials(fullName)}
            </span>
            <span className="truncate text-[12.5px] font-medium text-topbar-ink">{fullName}</span>
          </span>
          {/* ThemeToggle hardcodes text-ink-3 (correct on every other
              surface in the app) — invisible on this bar's black
              background, so its color is force-overridden here rather than
              adding a topbar-aware prop to a component used everywhere else. */}
          <span className="[&_button]:!text-topbar-ink [&_button:hover]:!text-white">
            <ThemeToggle />
          </span>
        </span>
      </header>

      {/* Sidebar — fixed below the top bar. */}
      <aside className="fixed inset-y-0 left-0 top-14 z-40 hidden w-60 flex-col border-r border-line-soft bg-sidebar-bg md:flex">
        <div className="flex-1 overflow-y-auto py-3">
          <SidebarNav links={links} />
        </div>

        <div className="border-t border-line-soft p-3">
          <div className="flex items-center justify-between gap-2 px-1">
            <span className="truncate text-[11px] capitalize text-ink-3">{role.replace("_", " ")}</span>
            <span className="flex items-center gap-2.5">
              <LanguageSwitcher current={lang} />
              <SignOutButton label={t.signOut} />
            </span>
          </div>
        </div>
      </aside>

      {/* Mobile: sidebar collapses to a slim link row under the top bar. */}
      <nav className="fixed inset-x-0 top-14 z-40 flex flex-wrap gap-x-3 gap-y-1 border-b border-line-soft bg-sidebar-bg px-4 py-2 text-[12.5px] text-ink-2 md:hidden">
        {links.map((l) => (
          <a key={l.href} href={l.href} className="hover:text-ink">
            {l.label}
          </a>
        ))}
      </nav>

      <div className="pt-14 md:ml-60">
        <div className="mx-auto max-w-[1280px] px-8 pb-24">{children}</div>
      </div>
    </div>
  );
}
