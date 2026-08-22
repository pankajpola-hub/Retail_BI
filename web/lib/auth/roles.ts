import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/data/client";
import { getPermit } from "@/lib/permit/client";

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

// 0061_business_unit.sql — the gate checked BEFORE role/store: can this user
// see this BUSINESS at all. Retail is everything that exists today; Ecomm
// (Uniware) has no pages yet, so PAGE_BUSINESS_UNIT below tags every current
// page "retail" — this becomes load-bearing the moment a real Ecomm page is
// added, not before.
export type BusinessUnit = "retail" | "ecomm";

export type CurrentUser = {
  id: string;
  fullName: string;
  role: AppRole;
  storeIds: string[]; // from core.fn_user_store_ids() — [] means "no stores granted", not "all stores"
  businessUnits: BusinessUnit[]; // from core.fn_user_business_units() — explicit-grant-only, no role-based auto-all (see 0061's header)
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

// Same pattern as resolveCallerStoreIds, for core.fn_user_business_units()
// (0061_business_unit.sql).
const resolveCallerBusinessUnits = cache(async (): Promise<BusinessUnit[]> => {
  const supabase = await createClient();
  const { data } = await supabase.schema("core").rpc<BusinessUnit[]>("fn_user_business_units");
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
  const businessUnits = await resolveCallerBusinessUnits();

  return {
    id: userId,
    fullName,
    role,
    storeIds,
    businessUnits,
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
  | "configurations"
  | "ecomm";

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
  "ecomm",
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
  ecomm: "Ecomm",
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
  // First Ecomm page (0067's semantic layer). No dedicated "Ecomm manager"
  // role exists (and adding a new core.app_role enum value is a bigger,
  // harder-to-reverse change than this warrants) — so this reuses the two
  // existing roles that already fit: ho_admin/super_admin (retained for
  // admin oversight, same as data-upload/configurations), plus `marketing`,
  // which is the closest existing role semantically — it already gates a
  // sales-channel page (/campaigns, see (marketing)/layout.tsx) and, unlike
  // ebo_manager/regional_manager, is NOT store-scoped (no
  // core.fn_user_store_ids() dependency anywhere marketing writes data), so
  // it doesn't carry retail-store baggage that doesn't apply to Ecomm.
  // Business unit (PAGE_BUSINESS_UNIT.ecomm = "ecomm", checked below) is the
  // real, primary gate here — a `marketing` user only reaches this page if
  // they *also* hold an explicit 'ecomm' grant in core.user_business_units;
  // this role list is just the coarser second filter on top of that, same
  // relationship every other PAGE_ROLE_DEFAULTS entry already has to its
  // business_unit. ebo_manager was deliberately left out: it's the role that
  // writes daily footfall/remarks scoped to physical stores (0032) — Ecomm
  // has no store concept, so that role doesn't fit even though it exists.
  ecomm: ["ho_admin", "super_admin", "marketing"],
};

// Which business unit each page belongs to — checked in requirePageAccess()
// alongside (not instead of) PAGE_ROLE_DEFAULTS: role decides WHAT within a
// business a caller can see, this decides WHICH business they're in at all.
// "ecomm" below is the first page this map actually does anything for —
// every user must hold an explicit 'ecomm' grant (core.user_business_units,
// 0061) to reach it, on top of the role check above.
export const PAGE_BUSINESS_UNIT: Record<PageKey, BusinessUnit> = {
  network: "retail",
  "stock-details": "retail",
  replenishment: "retail",
  footfall: "retail",
  targets: "retail",
  users: "retail",
  integrations: "retail",
  "data-upload": "retail",
  workspace: "retail",
  configurations: "retail",
  ecomm: "ecomm",
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
 * (admin)/integrations, (ecomm)/ecomm. Every other page.tsx in the app (my-store,
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

/**
 * Permit.io gate (promoted from shadow mode 2026-08-22, now that
 * core.user_page_overrides is mirrored into Permit.io too — see
 * syncPermitOverridesForUser in users/actions.ts). A second, independent
 * "is this allowed" answer, ANDed into the Postgres decision in
 * requirePageAccess below rather than trusted alone — matching the app's
 * existing UX-convenience-not-sole-security-boundary posture (the comment on
 * requirePageAccess itself), just with two systems agreeing instead of one.
 *
 * FAILS OPEN on any Permit.io error (network, outage, auth) — returns `true`
 * and only logs. Postgres/RLS remains the actual security boundary
 * regardless of what this returns, so a third-party SaaS outage must not be
 * able to take the whole app down; it can only ever narrow what Postgres
 * already decided, via a real (non-error) `false`, never by failing.
 * Mismatches are still logged either way, so a real policy drift between the
 * two systems stays visible rather than silently swallowed.
 */
async function checkPermitGate(userId: string, pageKey: PageKey, postgresAllowed: boolean): Promise<boolean> {
  try {
    const permit = getPermit();
    const permitAllowed = await permit.check(userId, "view", pageKey);
    if (permitAllowed !== postgresAllowed) {
      console.warn(
        `[permit] mismatch: page="${pageKey}" user=${userId} postgres=${postgresAllowed} permit=${permitAllowed}`
      );
    }
    return permitAllowed;
  } catch (err) {
    console.warn(`[permit] check failed, failing OPEN: page="${pageKey}" user=${userId}`, err);
    return true;
  }
}

export async function requirePageAccess(pageKey: PageKey): Promise<CurrentUser> {
  const resolved = await resolveCallerProfile();
  if (!resolved.ok) redirectForUnresolvedCaller(resolved.reason);
  const { userId, fullName, role } = resolved;

  const override = await resolveOverride(userId, pageKey);
  const roleAllowed = override !== null ? override : PAGE_ROLE_DEFAULTS[pageKey].includes(role);

  const permitAllowed = await checkPermitGate(userId, pageKey, roleAllowed);

  const businessUnits = await resolveCallerBusinessUnits();
  const businessUnitAllowed = businessUnits.includes(PAGE_BUSINESS_UNIT[pageKey]);

  const allowed = roleAllowed && permitAllowed && businessUnitAllowed;

  if (!allowed) {
    redirect(ROLE_HOME[role]);
  }

  const storeIds = await resolveCallerStoreIds();

  return {
    id: userId,
    fullName,
    role,
    storeIds,
    businessUnits,
  };
}
