import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/data/client";

export type AppRole =
  | "super_admin"
  | "ho_admin"
  | "regional_manager"
  | "ebo_manager"
  | "marketing";

// Every value here must be a real route's actual URL — route group folder
// names like (admin)/(ho)/(ebo)/(marketing) are invisible in the URL (that's
// the whole point of a route group: shared layout, no path segment), so
// don't reason about these paths from the folder structure. Two bugs already
// came from getting this wrong: "/admin" had no page.tsx behind it (404),
// and "/marketing/campaigns" doesn't exist — the real path is "/campaigns".
// Every role lands on /network after login — see (ho)/layout.tsx (requireRole
// now includes ebo_manager and marketing) and TopNav's NAV_LINKS (same
// widened role list), which were both loosened together with this change so
// a role that lands here by default can also always navigate back to it.
export const ROLE_HOME: Record<AppRole, string> = {
  super_admin: "/network",
  ho_admin: "/network",
  regional_manager: "/network",
  ebo_manager: "/network",
  marketing: "/network",
};

export type CurrentUser = {
  id: string;
  fullName: string;
  role: AppRole;
  storeIds: string[]; // from core.fn_user_store_ids() — [] means "no stores granted", not "all stores"
};

// Shared by requireRole and requirePageAccess below — resolves the caller's
// session to a core.profiles row. Every route group's layout.tsx calls one
// of requireRole/requirePageAccess, and (per a perf audit) almost every
// individual page.tsx underneath it calls another one again as an
// "independent re-check" — so within a single request/render pass this ends
// up invoked 2+ times. React's cache() memoizes this per-request (keyed on
// there being no arguments — the implicit input is the request's cookies,
// which don't change mid-request), so the second call reuses the first
// call's result instead of re-hitting auth.getUser() + a core.profiles
// select over the network again. Cleared automatically between requests —
// this is NOT a cross-request/cross-user cache.
//
// Returns a discriminated result instead of redirecting itself, so the two
// different redirect targets ("no session" -> /login, "no provisioned
// profile" -> /login?error=not_provisioned) stay decided by the caller, same
// as before — cache() memoizes the return value, and a thrown redirect()
// would otherwise get "cached" as a thrown exception on the first call and
// have no defined behavior on a memoized replay.
const resolveCallerProfile = cache(
  async (): Promise<
    { ok: true; userId: string; fullName: string; role: AppRole } | { ok: false; reason: "no_session" | "not_provisioned" }
  > => {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return { ok: false, reason: "no_session" };

    const { data: profile } = await supabase
      .schema("core")
      .from<{ full_name: string; role: AppRole }>("profiles")
      .select("full_name, role")
      .eq("user_id", user.id)
      .single();

    // Session exists but provisioning (core.profiles insert) hasn't happened
    // or failed — never default this to a role. See rbac-auth-setup.md §1.
    if (!profile) return { ok: false, reason: "not_provisioned" };

    return { ok: true, userId: user.id, fullName: profile.full_name, role: profile.role as AppRole };
  }
);

// Same per-request memoization as resolveCallerProfile above, for the other
// call every page/layout makes right after resolving the profile.
const resolveCallerStoreIds = cache(async (): Promise<string[]> => {
  const supabase = await createClient();
  const { data } = await supabase.schema("core").rpc<string[]>("fn_user_store_ids");
  return data ?? [];
});

function redirectForUnresolvedCaller(reason: "no_session" | "not_provisioned"): never {
  redirect(reason === "no_session" ? "/login" : "/login?error=not_provisioned");
}

/**
 * Layer 2 from docs/rbac-auth-setup.md §4: given a session already confirmed
 * valid by middleware.ts, fetch the role and redirect away from route groups
 * that don't belong to it. This is a UX convenience, not the security
 * boundary — see the file header comment for why. The actual data returned
 * by any query on the resulting page is still governed by RLS + the same
 * fn_user_store_ids() this reads from, independently, on the database side.
 */
export async function requireRole(...allowed: AppRole[]): Promise<CurrentUser> {
  const resolved = await resolveCallerProfile();
  if (!resolved.ok) redirectForUnresolvedCaller(resolved.reason);
  const { userId, fullName, role } = resolved;

  if (!allowed.includes(role)) {
    redirect(ROLE_HOME[role]);
  }

  const storeIds = await resolveCallerStoreIds();

  return {
    id: userId,
    fullName,
    role,
    storeIds,
  };
}

// Every nav-visible top-level page that requirePageAccess() below knows how
// to gate. Kept as a closed union (not derived from NAV_LINKS in TopNav.tsx,
// which is a client-facing display concern) so a typo in a page_key string
// anywhere in the admin UI or a requirePageAccess() call is a compile error.
export type PageKey =
  | "network"
  | "stock-details"
  | "replenishment"
  | "footfall"
  | "targets"
  | "users"
  | "integrations"
  | "data-upload"
  | "workspace"
  | "configurations";

export const PAGE_KEYS: PageKey[] = [
  "network",
  "stock-details",
  "replenishment",
  "footfall",
  "targets",
  "users",
  "integrations",
  "data-upload",
  "workspace",
  "configurations",
];

export const PAGE_LABELS: Record<PageKey, string> = {
  network: "Network",
  "stock-details": "Stock Details",
  replenishment: "Replenishment",
  footfall: "Footfall",
  targets: "Targets",
  users: "Users",
  integrations: "Integrations",
  "data-upload": "Data Upload",
  workspace: "Workspace",
  configurations: "Configurations",
};

// Role defaults mirrored from each route group's requireRole() call /
// TopNav's NAV_LINKS.roles — the "would this role normally see this page"
// answer requirePageAccess() needs BEFORE it knows whether a per-user
// override exists, since an override can widen access (allowed: true for a
// role that isn't listed here) as well as narrow it. If a page's role list
// changes, update it in both places — there isn't a single source of truth
// for this today; see the report from the agent that built this feature for
// why threading one wasn't attempted for every page.
export const PAGE_ROLE_DEFAULTS: Record<PageKey, AppRole[]> = {
  network: ["ho_admin", "regional_manager", "super_admin", "ebo_manager", "marketing"],
  "stock-details": ["ho_admin", "regional_manager", "super_admin", "ebo_manager", "marketing"],
  // Same role list as stock-details — a store manager (ebo_manager) deciding
  // whether to expect a warehouse replenishment needs to see this same as
  // they see current stock; write access (none exists yet, V1 is read-only
  // recommendations) would need its own narrower gate if added later.
  replenishment: ["ho_admin", "regional_manager", "super_admin", "ebo_manager", "marketing"],
  footfall: ["ebo_manager", "ho_admin", "super_admin"],
  // ebo_manager added (0032) so store staff can write the new daily Remarks
  // column on /targets — see web/app/(ho)/targets/page.tsx's canSetTargets
  // vs canWriteRemarks split: everything else on the page (setting monthly
  // Fresh/Discounted targets, bulk upload, incentive uploads) stays gated to
  // ho_admin/super_admin exactly as before, only remarks writing widens.
  // ops.daily_target_remarks' own RLS (0032) additionally scopes an
  // ebo_manager's writes to stores in core.fn_user_store_ids() only.
  targets: ["ho_admin", "regional_manager", "super_admin", "ebo_manager"],
  users: ["super_admin"],
  integrations: ["super_admin"],
  "data-upload": ["ho_admin", "super_admin"],
  // Personal workspaces only (Phase 5) — every role that lands on /network
  // can build their own, same breadth as network itself. Each workspace is
  // owner-scoped at the RLS layer (workspace.workspaces owner_id =
  // core.current_user_id()), so widening this list only ever grants access
  // to a role's OWN future workspaces, never anyone else's.
  workspace: ["ho_admin", "regional_manager", "super_admin", "ebo_manager", "marketing"],
  // Admin-only settings surface (0057/0058) — same posture as users/
  // integrations. Everything it holds today (the Fresh/EOSS classification
  // source) affects every role's dashboards, but only super_admin may change
  // it; store/sales roles have no access at all unless a future per-user
  // override widens it, same override mechanism as every other page here.
  configurations: ["super_admin"],
};

/**
 * Layer 2, override-aware (migration 0035, core.user_page_overrides): same
 * "redirect away if not allowed" contract as requireRole, except the
 * allow/deny decision is "per-user override row if one exists, else the
 * role default in PAGE_ROLE_DEFAULTS" instead of a plain role-list check.
 * This can't be built as "call requireRole(), then apply the override on
 * top" — requireRole's own role-list check would already have redirected
 * away the allowed:true-override case (a role granted a page it's not
 * normally allowed) before this function got a chance to widen it. So this
 * re-derives the role-default answer itself via PAGE_ROLE_DEFAULTS.
 *
 * Same UX-convenience-not-security-boundary caveat as requireRole: the
 * database's own RLS + core.fn_user_store_ids() still gate what data any
 * query returns, independent of this.
 *
 * Wired up for: (ho)/network, (ho)/targets, (ebo)/footfall,
 * (stock-details)/stock-details (via its layout, since that route group has
 * exactly one page), (data-upload)/data-upload (ditto), (admin)/users,
 * (admin)/integrations. Every other page.tsx in the app (my-store,
 * campaigns, and anything without a nav entry) still only respects
 * requireRole's plain role check — see the report for the full list.
 */
// Cached per (userId, pageKey) within the request — a given page's layout +
// page.tsx both calling requirePageAccess(SAME pageKey) is the common case
// this dedupes; different pageKeys naturally get separate (uncached) lookups
// since they're genuinely different data.
const resolveOverride = cache(async (userId: string, pageKey: PageKey): Promise<boolean | null> => {
  const supabase = await createClient();
  const { data: override } = await supabase
    .schema("core")
    .from<{ allowed: boolean }>("user_page_overrides")
    .select("allowed")
    .eq("user_id", userId)
    .eq("page_key", pageKey)
    .maybeSingle();
  return override ? override.allowed : null;
});

export async function requirePageAccess(pageKey: PageKey): Promise<CurrentUser> {
  const resolved = await resolveCallerProfile();
  if (!resolved.ok) redirectForUnresolvedCaller(resolved.reason);
  const { userId, fullName, role } = resolved;

  const override = await resolveOverride(userId, pageKey);
  const allowed = override !== null ? override : PAGE_ROLE_DEFAULTS[pageKey].includes(role);

  if (!allowed) {
    redirect(ROLE_HOME[role]);
  }

  const storeIds = await resolveCallerStoreIds();

  return {
    id: userId,
    fullName,
    role,
    storeIds,
  };
}
