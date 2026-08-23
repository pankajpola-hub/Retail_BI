import type { AppRole, BusinessUnit, PageKey } from "@/lib/auth/roles";
import { PAGE_BUSINESS_UNIT } from "@/lib/auth/roles";
import { SidebarNav, type SidebarLink } from "./SidebarNav";
import { SignOutButton } from "./SignOutButton";
import { ThemeToggle } from "./ThemeToggle";
import { DeniedNotice } from "./DeniedNotice";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { getLang } from "@/lib/i18n/server";
import { DICTIONARIES, type Dict } from "@/lib/i18n/translations";
import { resolveAccess } from "@/lib/auth/access";

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
  "/stock-details": "stock-details",
  "/replenishment": "replenishment",
  "/movement": "replenishment",
  "/footfall": "footfall",
  "/targets": "targets",
  "/users": "users",
  "/integrations": "integrations",
  "/data-upload": "data-upload",
  "/workspace": "workspace",
  "/configurations": "configurations",
  // /sales deliberately has NO entry here — it merges what "network" and
  // "ecomm" used to gate separately, and each of those page_keys carries a
  // single PAGE_BUSINESS_UNIT (retail vs ecomm) that would incorrectly
  // exclude an ecomm-only or ebo-only user from the merged page. /sales
  // does its own per-vertical narrowing internally (resolveViewScope), so
  // it falls through to the plain role check below — same precedent
  // /sale-stock-mix already established for a page with no page_key.
};

type NavLink = { href: string; labelKey: keyof Dict; icon: SidebarLink["icon"]; roles: AppRole[]; group: string };

// Group order below the array is the display order used by SidebarNav
// (Overview → Sales → Stock → Movement → Marketing → Workspace → Admin) —
// see NAV_GROUP_ORDER. Grouping is a pure visual reorganization: it doesn't
// touch href/labelKey/icon/roles or the business_unit/override/role filter
// below, which runs first and unmodified.
const NAV_LINKS: NavLink[] = [
  // Replaces the old separate /network and /ecomm links (Phase 2 of the
  // unified Sales explore) — one entry, role list is the UNION of both
  // pages' old role lists, since /sales does its own per-vertical
  // narrowing internally rather than relying on this nav filter or a
  // single PAGE_BUSINESS_UNIT the way each separate page used to.
  { href: "/sales", labelKey: "navNetwork", icon: "network", roles: ["ho_admin", "regional_manager", "super_admin", "ebo_manager", "marketing"], group: "Overview" },
  { href: "/stock-details", labelKey: "navStockDetails", icon: "stock", roles: ["ho_admin", "regional_manager", "super_admin", "ebo_manager", "marketing"], group: "Stock" },
  { href: "/movement", labelKey: "navMovement", icon: "replenishment", roles: ["ho_admin", "regional_manager", "super_admin", "ebo_manager", "marketing"], group: "Movement" },
  { href: "/footfall", labelKey: "navFootfall", icon: "footfall", roles: ["ebo_manager", "ho_admin", "super_admin"], group: "Overview" },
  { href: "/targets", labelKey: "navTargets", icon: "targets", roles: ["ho_admin", "super_admin"], group: "Overview" },
  { href: "/workspace", labelKey: "navWorkspace", icon: "workspace", roles: ["ho_admin", "regional_manager", "super_admin", "ebo_manager", "marketing"], group: "Workspace" },
  { href: "/users", labelKey: "navUsers", icon: "users", roles: ["super_admin"], group: "Admin" },
  { href: "/integrations", labelKey: "navIntegrations", icon: "integrations", roles: ["super_admin"], group: "Admin" },
  { href: "/data-upload", labelKey: "navDataUpload", icon: "upload", roles: ["ho_admin", "super_admin"], group: "Admin" },
  { href: "/configurations", labelKey: "navConfigurations", icon: "configurations", roles: ["super_admin"], group: "Admin" },
];

const NAV_GROUP_ORDER = ["Overview", "Sales", "Stock", "Movement", "Marketing", "Workspace", "Admin"];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

// Deterministic shade from the name, so the same person always gets the
// same badge across sessions instead of a random one on every render.
// 2026-08-23: was five different HUES (mint/violet/pink/orange/blue) — the
// single largest source of stray colour left in the shell after the
// monochrome pass. Now a neutral LIGHTNESS ramp instead: same
// per-person determinism, no colour. These sit on the black top bar, so
// the ramp stays in the light half to keep the initials readable.
const AVATAR_SHADES = ["#e6e6e8", "#cfcfd3", "#b8b8be", "#a1a1a9", "#8a8a94"];
function avatarShade(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_SHADES[hash % AVATAR_SHADES.length]!;
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

  // 0079: the nav asks resolveAccess() the SAME question requirePageAccess()
  // asks, so a page the user would be bounced off never appears in the
  // sidebar in the first place. Previously this read core.user_page_overrides
  // directly with its own hand-rolled precedence, which meant the nav and the
  // route gate could disagree — and after 0079 moved overrides to a new table
  // they immediately did: a denied page still showed a link that bounced you.
  const access = await resolveAccess();

  const filteredNavLinks = NAV_LINKS.filter((l) => {
    const pageKey = HREF_PAGE_KEY[l.href];
    // Business unit gates first — same "which business at all, before role/
    // override even apply" ordering as requirePageAccess() in
    // lib/auth/roles.ts. /sale-stock-mix has no PAGE_KEY entry (pre-existing
    // gap, not introduced here) so it skips this check same as it already
    // skipped the access check below.
    if (pageKey && !businessUnits.includes(PAGE_BUSINESS_UNIT[pageKey])) return false;
    if (pageKey && access) return access.can(`${pageKey}.view`);
    return l.roles.includes(role);
  });
  const links: SidebarLink[] = filteredNavLinks.map((l) => ({ href: l.href, label: t[l.labelKey], icon: l.icon }));

  // Grouping is a pure post-processing step on the already-filtered links —
  // it never changes which links are visible, only how they're clustered.
  // NAV_GROUP_ORDER fixes the section order; groups with no visible links
  // (e.g. "Marketing" until a Campaigns link exists) are simply omitted.
  const groupedLinks: { group: string; links: SidebarLink[] }[] = NAV_GROUP_ORDER.map((group) => ({
    group,
    links: filteredNavLinks
      .filter((l) => l.group === group)
      .map((l) => ({ href: l.href, label: t[l.labelKey], icon: l.icon })),
  })).filter((g) => g.links.length > 0);

  const shade = avatarShade(fullName);

  return (
    <div className="min-h-screen bg-ground">
      {/* Top bar — fixed, full width, above both sidebar and content. */}
      <header className="fixed inset-x-0 top-0 z-50 flex h-14 items-center justify-between gap-4 bg-topbar-bg px-4">
        <a href="/sales" className="flex shrink-0 items-center gap-2">
          {/* On the black top bar specifically, the brandmark stays white-on
              -dark in both themes — it sits on --topbar-bg, not on a surface
              that flips, so it deliberately does NOT use bg-accent. */}
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-white text-[13px] font-bold text-black">
            E
          </span>
          <span className="hidden truncate text-[14.5px] font-semibold text-white sm:inline">{t.appName}</span>
        </a>

        <span className="flex items-center gap-3">
          <span className="hidden items-center gap-2 rounded-full bg-white/10 py-1 pl-1 pr-3 sm:flex">
            <span
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10.5px] font-bold text-black"
              style={{ backgroundColor: shade }}
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
          <SidebarNav groups={groupedLinks} />
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
        <div className="mx-auto max-w-[1280px] px-8 pb-24">
          {/* Renders only when requirePageAccess() bounced the user here with
              ?denied=… — see DeniedNotice. Lives in the shell rather than per
              page so it works wherever resolveHome() happens to land them. */}
          <DeniedNotice />
          {children}
        </div>
      </div>
    </div>
  );
}
