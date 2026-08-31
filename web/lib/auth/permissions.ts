/**
 * Pure permission constants and key helpers — NO server-only imports.
 *
 * This module exists because of a real bug it now prevents. `lib/auth/roles.ts`
 * is server-only (it imports the Supabase client and the Permit.io SDK), so
 * the admin UI's client components could not import from it. The page-access
 * client component therefore re-declared its OWN `PageKey` union by hand —
 * and drifted: it listed 7 pages while `requirePageAccess()` gated 11, so
 * Movement, Workspace, Configurations and Ecomm were gated by the server but
 * had no admin control at all. Nobody could grant or revoke them.
 *
 * Anything both a server module and a client component need to agree on
 * belongs HERE, imported by both, so the two can never diverge again. Same
 * lesson ReplenishmentGrid.tsx's header documents about "server-only" modules.
 */

export type AppRole =
  | "super_admin"
  | "ho_admin"
  | "regional_manager"
  | "ebo_manager"
  | "marketing";

export const APP_ROLES: AppRole[] = [
  "super_admin",
  "ho_admin",
  "regional_manager",
  "ebo_manager",
  "marketing",
];

export const ROLE_LABELS: Record<AppRole, string> = {
  super_admin: "Super Admin",
  ho_admin: "HO Admin",
  regional_manager: "Regional Manager",
  ebo_manager: "EBO Manager",
  marketing: "Marketing",
};

export type UserStatus = "active" | "disabled";

/**
 * The 11 top-level pages `requirePageAccess()` gates. Note `replenishment` is
 * the key for the /movement route — the route was renamed, the page_key was
 * deliberately not (see HREF_PAGE_KEY in components/ui/AppShell.tsx).
 *
 * `sales` (2026-08-28, was `network`): /network is now just a redirect stub
 * superseded by /sales, and the nav link has pointed straight at /sales for
 * a while — renamed to match what's actually being gated, and to give
 * /sales itself a real per-user override control (it previously only used
 * requireRole(), bypassing overrides entirely). See migration
 * 0100_rename_network_permission_to_sales.sql for the matching DB-side
 * rename of core.role_permissions/core.feature_keys.
 */
export type PageKey =
  | "sales"
  | "stock-details"
  | "replenishment"
  | "footfall"
  | "targets"
  | "users"
  | "integrations"
  | "data-upload"
  | "workspace"
  | "configurations"
  | "ecomm"
  // Sale Summary (migration 0101) — wholesale/distribution-channel sales
  // (agents, distributors, LFS, MBO, ecomm marketplaces). A different
  // business view from every page above, all of which are EBO-retail-
  // focused; see server/db/migrations/0101_channel_sales_summary.sql.
  | "sale-summary";

export const PAGE_KEYS: PageKey[] = [
  "sales",
  "stock-details",
  "replenishment",
  "footfall",
  "targets",
  "users",
  "integrations",
  "data-upload",
  "workspace",
  "configurations",
  "ecomm",
  "sale-summary",
];

export const PAGE_LABELS: Record<PageKey, string> = {
  sales: "Sales",
  "stock-details": "Stock Details",
  replenishment: "Movement",
  footfall: "Footfall",
  targets: "Targets",
  users: "Users",
  integrations: "Integrations",
  "data-upload": "Data Upload",
  workspace: "Workspace",
  configurations: "Configurations",
  ecomm: "Ecomm",
  "sale-summary": "Sale Summary",
};

/**
 * The second axis of the permission matrix. Browsing 40+ keys page-by-page is
 * workable; being able to ask "show me everything that EXPORTS data" and deny
 * it in one pass is what makes the admin UI usable rather than a wall of
 * checkboxes. Mirrors core.feature_keys.action_class (migration 0079).
 */
export type ActionClass = "view" | "edit" | "export" | "admin";

export const ACTION_CLASSES: ActionClass[] = ["view", "edit", "export", "admin"];

export const ACTION_CLASS_LABELS: Record<ActionClass, string> = {
  view: "View",
  edit: "Edit",
  export: "Export",
  admin: "Admin",
};

/** A permission key: `<page>.view` for a page, `<page>.<feature>.<action>` for a feature. */
export type PermissionKey = string;

/** `network.agent_sales.view` -> `network`. */
export function pageKeyOf(key: PermissionKey): string {
  return key.split(".")[0] ?? key;
}

/** The page-level key that governs a feature key: `network.agent_sales.view` -> `network.view`. */
export function parentPageKeyOf(key: PermissionKey): PermissionKey {
  return `${pageKeyOf(key)}.view`;
}

/** A page's own key has exactly two segments; anything longer is a feature on it. */
export function isPageKey(key: PermissionKey): boolean {
  return key.split(".").length === 2;
}

/**
 * Every ancestor key that can deny `key`, nearest first. Today that's just the
 * page key, but returning a list keeps the precedence rule ("a deny on a parent
 * always beats an allow on a child") correct if deeper nesting is ever added.
 */
export function ancestorsOf(key: PermissionKey): PermissionKey[] {
  const parts = key.split(".");
  if (parts.length <= 2) return [];
  return [parentPageKeyOf(key)];
}
