import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/data/client";
import {
  ancestorsOf,
  type AppRole,
  type PermissionKey,
  type UserStatus,
} from "./permissions";

/**
 * The single place "can this user do X" is answered (migration 0079).
 *
 * Replaces a model where permission truth lived in three places, none of them
 * editable without a deploy: PAGE_ROLE_DEFAULTS (a hardcoded TS map),
 * core.app_role (a Postgres enum), and Permit.io (a mirrored copy). The role
 * defaults now live in core.role_permissions, so an admin can change them at
 * runtime, and the same key space covers both pages and the features on them.
 *
 * PRECEDENCE — the rule the whole system rests on, so it lives in exactly one
 * function (`can` below) rather than being re-derived per call site:
 *
 *   1. status = 'disabled'                 -> deny everything
 *   2. an exact-key user override          -> wins outright
 *   3. a DENY override on an ancestor key  -> cascades down
 *   4. the role default (role_permissions)
 *   5. otherwise deny
 *
 * Rule of thumb: a deny on a parent always beats an allow on a child.
 *
 * The BUSINESS UNIT gate is deliberately NOT here — it's a coarser, earlier
 * question ("which business is this user in at all") and stays in
 * requirePageAccess() alongside PAGE_BUSINESS_UNIT, exactly as before.
 *
 * NOT A SECURITY BOUNDARY. This tailors what a page renders. The real boundary
 * is Postgres RLS + core.fn_user_store_ids(), which is untouched: a wrong
 * feature toggle means someone sees a table they didn't need, never another
 * store's data.
 */

export type AccessSet = {
  userId: string;
  fullName: string;
  role: AppRole;
  status: UserStatus;
  /** Keys granted by the caller's role, before per-user overrides. */
  rolePermissions: ReadonlySet<PermissionKey>;
  /** Per-user exceptions: true = explicit allow, false = explicit deny. */
  overrides: ReadonlyMap<PermissionKey, boolean>;
  can: (key: PermissionKey) => boolean;
  /** Same answer as `can`, plus WHY — powers the admin UI's effective-access panel. */
  explain: (key: PermissionKey) => AccessDecision;
};

export type AccessDecision = {
  allowed: boolean;
  /** Which precedence rule decided it. */
  reason: "disabled" | "override" | "parent_denied" | "role_default" | "not_granted";
  /** For parent_denied, the ancestor key that did it. */
  via?: PermissionKey;
};

type ProfileRow = { user_id: string; full_name: string; role: AppRole; status: UserStatus };
type RolePermissionRow = { permission_key: string };
type OverrideRow = { permission_key: string; allowed: boolean };

function decide(
  status: UserStatus,
  rolePermissions: ReadonlySet<PermissionKey>,
  overrides: ReadonlyMap<PermissionKey, boolean>,
  key: PermissionKey
): AccessDecision {
  // 1. A disabled account is denied everything, regardless of role or override.
  if (status === "disabled") return { allowed: false, reason: "disabled" };

  // 2. A DENY on an ancestor cascades, and it is checked BEFORE the exact key
  //    so that "a deny on a parent always beats an allow on a child" actually
  //    holds. Ordering these the other way round (exact key first) looks
  //    natural and is wrong: a stale explicit Allow left on one feature would
  //    resurrect part of a page the admin had just denied wholesale, and the
  //    admin UI would report that feature as "Allowed" even though
  //    requirePageAccess() redirects the user off the page before they could
  //    ever reach it. Caught by the effective-access panel showing exactly
  //    that contradiction.
  //
  //    Note the asymmetry: only a DENY cascades. An ALLOW on a page does not
  //    auto-grant every feature on it — those keep their own role defaults —
  //    because widening by accident is the dangerous direction.
  for (const parent of ancestorsOf(key)) {
    if (overrides.get(parent) === false) {
      return { allowed: false, reason: "parent_denied", via: parent };
    }
  }

  // 3. An exact-key override wins over the role default, in either direction —
  //    this is how an admin both widens (granting a role something it wouldn't
  //    normally have) and narrows (revoking something the role grants).
  const exact = overrides.get(key);
  if (exact !== undefined) return { allowed: exact, reason: "override" };

  // 4/5. Fall back to the role default; absent means deny.
  if (rolePermissions.has(key)) return { allowed: true, reason: "role_default" };
  return { allowed: false, reason: "not_granted" };
}

/**
 * Resolved once per request via React's cache(), for the same reason
 * lib/auth/roles.ts caches its own lookups: a route's layout.tsx and its
 * page.tsx both gate independently, so this would otherwise run 2+ times per
 * render. Keyed on no arguments — the implicit input is the request's cookies,
 * which don't change mid-request. Cleared between requests; NOT a cross-user
 * cache.
 */
export const resolveAccess = cache(async (): Promise<AccessSet | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .schema("core")
    .from<ProfileRow>("profiles")
    .select("user_id, full_name, role, status")
    .eq("user_id", user.id)
    .single();
  if (!profile) return null;

  const [{ data: rolePerms }, { data: overrideRows }] = await Promise.all([
    supabase
      .schema("core")
      .from<RolePermissionRow>("role_permissions")
      .select("permission_key")
      .eq("role", profile.role),
    supabase
      .schema("core")
      .from<OverrideRow>("user_permission_overrides")
      .select("permission_key, allowed")
      .eq("user_id", user.id),
  ]);

  const rolePermissions = new Set((rolePerms ?? []).map((r) => r.permission_key));
  const overrides = new Map((overrideRows ?? []).map((r) => [r.permission_key, r.allowed]));
  const status = profile.status ?? "active";

  return {
    userId: profile.user_id,
    fullName: profile.full_name,
    role: profile.role,
    status,
    rolePermissions,
    overrides,
    can: (key) => decide(status, rolePermissions, overrides, key).allowed,
    explain: (key) => decide(status, rolePermissions, overrides, key),
  };
});

/**
 * Resolve any user's access set — for the ADMIN UI's effective-access panel,
 * which must answer "what would this other person see". Uses the caller's own
 * client, so RLS still applies: core.user_permission_overrides' read policy
 * (0079) only exposes another user's rows to a super_admin.
 *
 * Not cached: it's called per-inspected-user from an admin screen, not on the
 * hot path of every page render the way resolveAccess() is.
 */
export async function resolveAccessForUser(userId: string): Promise<AccessSet | null> {
  const supabase = await createClient();

  const { data: profile } = await supabase
    .schema("core")
    .from<ProfileRow>("profiles")
    .select("user_id, full_name, role, status")
    .eq("user_id", userId)
    .single();
  if (!profile) return null;

  const [{ data: rolePerms }, { data: overrideRows }] = await Promise.all([
    supabase
      .schema("core")
      .from<RolePermissionRow>("role_permissions")
      .select("permission_key")
      .eq("role", profile.role),
    supabase
      .schema("core")
      .from<OverrideRow>("user_permission_overrides")
      .select("permission_key, allowed")
      .eq("user_id", userId),
  ]);

  const rolePermissions = new Set((rolePerms ?? []).map((r) => r.permission_key));
  const overrides = new Map((overrideRows ?? []).map((r) => [r.permission_key, r.allowed]));
  const status = profile.status ?? "active";

  return {
    userId: profile.user_id,
    fullName: profile.full_name,
    role: profile.role,
    status,
    rolePermissions,
    overrides,
    can: (key) => decide(status, rolePermissions, overrides, key).allowed,
    explain: (key) => decide(status, rolePermissions, overrides, key),
  };
}
