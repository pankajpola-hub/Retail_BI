"use server";

import { z } from "zod";
import { createClient } from "@/lib/data/client";
import { createAdminClient } from "@/lib/data/admin";
import {
  createSupabaseUser,
  setSupabaseUserPassword,
  setSupabaseUserBanned,
  updateSupabaseUserName,
} from "@/lib/supabase/userAdmin";
import { syncPermitUserAccess } from "@/lib/permit/client";
import type { AppRole, BusinessUnit, PageKey } from "@/lib/auth/roles";
import { PAGE_KEYS, PAGE_ROLE_DEFAULTS } from "@/lib/auth/roles";
import type { DataClient } from "@/lib/data/client";

const createUserSchema = z.object({
  email: z.string().email(),
  fullName: z.string().min(1),
  password: z.string().min(8, "Password must be at least 8 characters."),
  role: z.enum(["super_admin", "ho_admin", "regional_manager", "ebo_manager", "marketing"]),
  storeIds: z.array(z.string()),
  // 0061_business_unit.sql: explicit-grant-only, no role-based auto-all — a
  // brand-new user (even super_admin) gets exactly what's checked here, not
  // an implicit "both". min(1): a user with zero business units can't see
  // any page at all (PAGE_BUSINESS_UNIT gates before role/store even apply),
  // which is never what an admin creating an account actually wants.
  businessUnits: z.array(z.enum(["retail", "ecomm"])).min(1, "Select at least one business unit."),
});

/**
 * The one place in the app that provisions a user — see
 * docs/rbac-auth-setup.md §1. Two checks before any admin client is
 * constructed: the caller's own session must resolve to super_admin
 * (re-checked here, independent of whatever got them past the (admin)
 * layout gate — Server Actions are directly callable and must not assume
 * the layout ran), and only then does provisioning start.
 *
 * Instant, not an email invite — this realm has no SMTP configured, and
 * Supabase (unlike the retired Keycloak setup) has no reason to withhold a
 * password at creation, so the admin sets one right here and the account is
 * immediately usable. What follows is the core.profiles row and
 * core.user_store_access grants, keyed on the Supabase Auth user id — that
 * id IS the join the entire RLS model rests on.
 */
export async function createUser(input: z.infer<typeof createUserSchema>) {
  const { email, fullName, password, role, storeIds, businessUnits } = createUserSchema.parse(input);

  const supabase = await createClient();
  const {
    data: { user: caller },
  } = await supabase.auth.getUser();
  if (!caller) throw new Error("Not authenticated.");

  const { data: callerProfile } = await supabase
    .schema("core")
    .from<{ role: AppRole; full_name: string }>("profiles")
    .select("role, full_name")
    .eq("user_id", caller.id)
    .single();

  if (callerProfile?.role !== "super_admin") {
    throw new Error("Only super_admin can create users.");
  }

  // Identity first — core.profiles.user_id must match the identity
  // provider's id, so a failure here must abort before any DB row is
  // written rather than leave a profile pointing at nothing.
  const newUserId = await createSupabaseUser(email, fullName, password);

  const admin = await createAdminClient();

  const { error: profileError } = await admin
    .schema("core")
    .from<{ user_id: string; full_name: string; role: AppRole }>("profiles")
    .insert({ user_id: newUserId, full_name: fullName, role });
  if (profileError) throw new Error(profileError.message);

  // Permit.io sync (page-access gate, promoted from shadow mode 2026-08-22 —
  // see checkPermitGate in lib/auth/roles.ts). check() can only evaluate a
  // role it already knows about, so every user created from here on is
  // synced and role-assigned immediately. `effectivePages: null` — a
  // brand-new user has no core.user_page_overrides rows yet, so the plain
  // role assignment is the whole story; see syncPermitUserAccess's doc
  // comment for why an override changes this to a synthesized per-user role
  // instead. Non-fatal: checkPermitGate fails OPEN on its own errors, so a
  // Permit.io outage here would only mean a not-yet-synced user briefly
  // relies on that fail-open behavior, not a blocked account creation.
  try {
    await syncPermitUserAccess(newUserId, fullName, role, null);
  } catch (err) {
    console.warn(`[permit] sync failed for new user ${newUserId}:`, err);
  }

  if (storeIds.length > 0) {
    const { error: grantError } = await admin
      .schema("core")
      .from<{ user_id: string; store_id: string }>("user_store_access")
      .insert(storeIds.map((store_id) => ({ user_id: newUserId, store_id })));
    if (grantError) throw new Error(grantError.message);
  }

  // 0061_business_unit.sql — required by the schema above (min(1)), so this
  // always has at least one row, unlike storeIds which can legitimately be
  // empty (a role that doesn't need store scoping).
  const { error: businessUnitError } = await admin
    .schema("core")
    .from<{ user_id: string; business_unit: BusinessUnit }>("user_business_units")
    .insert(businessUnits.map((business_unit) => ({ user_id: newUserId, business_unit })));
  if (businessUnitError) throw new Error(businessUnitError.message);

  await writeAudit(
    admin,
    { id: caller.id, fullName: callerProfile.full_name },
    "user.create",
    { userId: newUserId, fullName },
    { email, role, storeIds, businessUnits }
  );
}

/**
 * Sets an existing user's password to an admin-chosen value, replacing
 * whatever was there before — same re-check-the-caller pattern as
 * createUser above, since Server Actions are directly callable regardless of
 * whether the (admin) layout's requireRole("super_admin") ran. Nothing is
 * generated or returned; the admin types the new password themselves and
 * hands it to the user out of band (no email — SMTP isn't configured on
 * this project).
 */
export async function setUserPassword(userId: string, newPassword: string): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user: caller },
  } = await supabase.auth.getUser();
  if (!caller) throw new Error("Not authenticated.");

  const { data: callerProfile } = await supabase
    .schema("core")
    .from<{ role: AppRole; full_name: string }>("profiles")
    .select("role, full_name")
    .eq("user_id", caller.id)
    .single();

  if (callerProfile?.role !== "super_admin") {
    throw new Error("Only super_admin can set passwords.");
  }

  if (newPassword.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }

  await setSupabaseUserPassword(userId, newPassword);

  // The password itself is never logged, obviously — only that a reset
  // happened, by whom, to whom, and when.
  const admin = await createAdminClient();
  const target = await loadProfile(admin, userId);
  await writeAudit(
    admin,
    { id: caller.id, fullName: callerProfile.full_name },
    "password.reset",
    { userId, fullName: target?.full_name }
  );
}

// Same "re-check the caller regardless of whether the (admin) layout's
// requireRole('super_admin') already ran" reasoning as resetUserPassword
// above — Server Actions are directly callable. Factored out here (the
// three actions above predate this helper and are left as-is rather than
// churned for a pure refactor) so renameUser/updateUserStoreAccess/
// updateUserPageOverrides don't each re-duplicate the lookup a fourth time.
//
// 0079: now returns the caller's NAME as well as their id, because every
// mutating action writes an audit row and the log denormalises actor_name so
// it stays readable after a rename or a deletion.
async function requireSuperAdminCaller(): Promise<{ id: string; fullName: string }> {
  const supabase = await createClient();
  const {
    data: { user: caller },
  } = await supabase.auth.getUser();
  if (!caller) throw new Error("Not authenticated.");

  const { data: callerProfile } = await supabase
    .schema("core")
    .from<{ role: AppRole; full_name: string }>("profiles")
    .select("role, full_name")
    .eq("user_id", caller.id)
    .single();

  if (callerProfile?.role !== "super_admin") {
    throw new Error("Only super_admin can manage users.");
  }

  return { id: caller.id, fullName: callerProfile.full_name };
}

/**
 * Appends to core.admin_audit_log (migration 0079). Never throws: an audit
 * write failing must not roll back or block the administrative action the
 * user actually asked for — a missing log line is bad, a half-applied
 * permission change is worse. Failures are logged loudly instead.
 *
 * Target name is denormalised at write time on purpose (see the table's
 * comment): the trail has to stay readable after the subject is renamed or
 * removed, and a join returning null defeats the point of having a trail.
 */
async function writeAudit(
  admin: DataClient,
  actor: { id: string; fullName: string },
  action: string,
  target: { userId?: string; fullName?: string } | null,
  detail: Record<string, unknown> = {}
): Promise<void> {
  try {
    const { error } = await admin
      .schema("core")
      .from<Record<string, unknown>>("admin_audit_log")
      .insert({
        actor_id: actor.id,
        actor_name: actor.fullName,
        action,
        target_user_id: target?.userId ?? null,
        target_user_name: target?.fullName ?? null,
        detail,
      });
    if (error) console.warn(`[audit] write failed for action="${action}":`, error.message);
  } catch (err) {
    console.warn(`[audit] write threw for action="${action}":`, err);
  }
}

/** Reads a profile's name/role/status for audit denormalisation and guard checks. */
async function loadProfile(
  admin: DataClient,
  userId: string
): Promise<{ full_name: string; role: AppRole; status: string } | null> {
  const { data } = await admin
    .schema("core")
    .from<{ full_name: string; role: AppRole; status: string }>("profiles")
    .select("full_name, role, status")
    .eq("user_id", userId)
    .single();
  return data ?? null;
}

/**
 * User feedback #15 ("give me option to rename the users in users page"):
 * updates the Keycloak firstName/lastName and core.profiles.full_name —
 * same pattern as createKeycloakUser/resetKeycloakUserPassword: identity
 * provider first, core.profiles second, both keyed on the same user_id.
 */
export async function renameUser(userId: string, fullName: string): Promise<void> {
  const caller = await requireSuperAdminCaller();

  const trimmed = fullName.trim();
  if (!trimmed) throw new Error("Name can't be empty.");

  await updateSupabaseUserName(userId, trimmed);

  const admin = await createAdminClient();
  const before = await loadProfile(admin, userId);

  const { error } = await admin
    .schema("core")
    .from<{ full_name: string }>("profiles")
    .update({ full_name: trimmed })
    .eq("user_id", userId);
  if (error) throw new Error(error.message);

  await writeAudit(admin, caller, "user.rename", { userId, fullName: trimmed }, {
    from: before?.full_name,
    to: trimmed,
  });
}

/**
 * User feedback #16a ("allocate the location"): replaces a user's full set
 * of core.user_store_access grants (migration 0003) with storeIds. Store
 * access only matters for ebo_manager/regional_manager — core.fn_user_store_ids()
 * returns every store for ho_admin/super_admin regardless — but this
 * doesn't restrict by role: an admin re-provisioning someone into a
 * store-scoped role later shouldn't need a separate first-time setup path.
 * Delete-then-insert rather than a diff, same tradeoff createUser already
 * makes implicitly (insert-only on a fresh user): simpler than computing
 * add/remove sets, at the cost of a moment where the user has zero grants
 * mid-transaction-less-round-trip. Acceptable here — this is an infrequent
 * admin action, not a hot path, and a mid-update read just sees "no stores"
 * briefly rather than stale or duplicated grants.
 */
export async function updateUserStoreAccess(userId: string, storeIds: string[]): Promise<void> {
  const caller = await requireSuperAdminCaller();

  const admin = await createAdminClient();
  const profile = await loadProfile(admin, userId);

  const { error: deleteError } = await admin
    .schema("core")
    .from<{ user_id: string; store_id: string }>("user_store_access")
    .delete()
    .eq("user_id", userId);
  if (deleteError) throw new Error(deleteError.message);

  if (storeIds.length > 0) {
    const { error: insertError } = await admin
      .schema("core")
      .from<{ user_id: string; store_id: string }>("user_store_access")
      .insert(storeIds.map((store_id) => ({ user_id: userId, store_id })));
    if (insertError) throw new Error(insertError.message);
  }

  await writeAudit(admin, caller, "stores.change", { userId, fullName: profile?.full_name }, {
    stores: storeIds,
  });
}

/**
 * Edits a user's core.user_business_units grants (0061_business_unit.sql) —
 * same delete-then-insert shape and tradeoff as updateUserStoreAccess above,
 * and the same reasoning for why that moment of zero grants mid-update is
 * acceptable (infrequent admin action, not a hot path). Unlike store/page
 * access, this is NOT mirrored into Permit.io — business_unit stays a
 * Postgres-only check (core.fn_user_business_units(), read directly in
 * requirePageAccess/AppShell) by design, so there's only one place this rule
 * lives; see lib/permit/client.ts's module doc for the reasoning.
 */
export async function updateUserBusinessUnits(userId: string, businessUnits: BusinessUnit[]): Promise<void> {
  const caller = await requireSuperAdminCaller();

  if (businessUnits.length === 0) {
    throw new Error("A user needs at least one business unit — otherwise every page is unreachable.");
  }

  const admin = await createAdminClient();
  const profile = await loadProfile(admin, userId);

  const { error: deleteError } = await admin
    .schema("core")
    .from<{ user_id: string; business_unit: BusinessUnit }>("user_business_units")
    .delete()
    .eq("user_id", userId);
  if (deleteError) throw new Error(deleteError.message);

  const { error: insertError } = await admin
    .schema("core")
    .from<{ user_id: string; business_unit: BusinessUnit }>("user_business_units")
    .insert(businessUnits.map((business_unit) => ({ user_id: userId, business_unit })));
  if (insertError) throw new Error(insertError.message);

  await writeAudit(admin, caller, "business_units.change", { userId, fullName: profile?.full_name }, {
    businessUnits,
  });
}

/**
 * Re-reads a user's FULL current override set (not just the delta a single
 * updateUserPageOverrides call touched — Permit.io needs the complete
 * effective picture, not an incremental patch) and mirrors it into
 * Permit.io's shadow-mode check via syncPermitUserAccess. Non-fatal by
 * design, same reasoning as createUser's sync call above.
 */
async function syncPermitOverridesForUser(admin: DataClient, userId: string): Promise<void> {
  const { data: profile } = await admin
    .schema("core")
    .from<{ full_name: string; role: AppRole }>("profiles")
    .select("full_name, role")
    .eq("user_id", userId)
    .single();
  if (!profile) return;

  const { data: overrideRows } = await admin
    .schema("core")
    .from<{ page_key: PageKey; allowed: boolean }>("user_page_overrides")
    .select("page_key, allowed")
    .eq("user_id", userId);

  try {
    if (!overrideRows || overrideRows.length === 0) {
      await syncPermitUserAccess(userId, profile.full_name, profile.role, null);
      return;
    }

    const overrideMap = new Map(overrideRows.map((r) => [r.page_key, r.allowed]));
    const effectivePages = PAGE_KEYS.filter((k) =>
      overrideMap.has(k) ? overrideMap.get(k)! : PAGE_ROLE_DEFAULTS[k].includes(profile.role)
    );
    await syncPermitUserAccess(userId, profile.full_name, profile.role, effectivePages);
  } catch (err) {
    console.warn(`[permit-shadow] override sync failed for ${userId}:`, err);
  }
}

/**
 * User feedback #16b ("the menu pages rights"): writes core.user_page_overrides
 * (migration 0035) — per-user exceptions on top of the role-based page
 * defaults (lib/auth/roles.ts PAGE_ROLE_DEFAULTS). `overrides` covers every
 * PageKey the admin UI shows a control for; a value of `null` means "clear
 * the override, defer back to the role default" (deletes the row rather
 * than writing one), `true`/`false` writes an explicit grant/revoke.
 * Delete-then-insert per key for the same reason as updateUserStoreAccess:
 * simpler than a real diff, and this is an infrequent low-volume admin
 * write (at most 7 rows).
 */
// ---------------------------------------------------------------------------
// 0079 — role change, user lifecycle, and feature-level permission overrides.
// ---------------------------------------------------------------------------

/**
 * Changes a user's role. There was previously NO way to do this: role was set
 * once by createUser() and then permanent, so correcting a mistake or moving
 * someone between jobs meant deleting and re-provisioning the account.
 *
 * Two guards, both about not locking the organisation out of its own admin:
 *   - you cannot change your OWN role (a super_admin demoting themselves
 *     immediately loses the ability to undo it)
 *   - you cannot remove the LAST super_admin
 */
export async function updateUserRole(userId: string, role: AppRole): Promise<void> {
  const caller = await requireSuperAdminCaller();

  if (userId === caller.id) {
    throw new Error("You can't change your own role — ask another super admin.");
  }

  const admin = await createAdminClient();
  const profile = await loadProfile(admin, userId);
  if (!profile) throw new Error("User not found.");
  if (profile.role === role) return;

  if (profile.role === "super_admin" && role !== "super_admin") {
    const { data: admins } = await admin
      .schema("core")
      .from<{ user_id: string }>("profiles")
      .select("user_id")
      .eq("role", "super_admin");
    if ((admins ?? []).length <= 1) {
      throw new Error("This is the last super admin — promote someone else first.");
    }
  }

  const { error } = await admin
    .schema("core")
    .from<{ role: AppRole }>("profiles")
    .update({ role })
    .eq("user_id", userId);
  if (error) throw new Error(error.message);

  await writeAudit(admin, caller, "role.change", { userId, fullName: profile.full_name }, {
    from: profile.role,
    to: role,
  });

  // Permit.io mirrors the caller's effective PAGE access and is keyed on the
  // role, so a role change has to re-sync or its second opinion goes stale
  // and starts producing [permit] mismatch warnings on every request.
  await syncPermitOverridesForUser(admin, userId);
}

/**
 * Enables or disables a user. Closes a genuine security hole: before this
 * there was no way to revoke a departing employee's access at all — stripping
 * their stores and business units locked them out of DATA, but the login kept
 * working indefinitely.
 *
 * Deliberately NOT a delete: core.profiles.user_id is the join the whole RLS
 * model rests on, and it's referenced by audit rows, saved views, workspaces
 * and targets. Disabling preserves that history; deleting would orphan or
 * cascade it. `status = 'disabled'` denies everything at precedence rule 1 in
 * lib/auth/access.ts, and the Supabase ban makes it immediate rather than
 * waiting for the current access token to expire.
 */
export async function setUserStatus(userId: string, status: "active" | "disabled"): Promise<void> {
  const caller = await requireSuperAdminCaller();

  if (userId === caller.id) {
    throw new Error("You can't disable your own account.");
  }

  const admin = await createAdminClient();
  const profile = await loadProfile(admin, userId);
  if (!profile) throw new Error("User not found.");
  if (profile.status === status) return;

  if (status === "disabled" && profile.role === "super_admin") {
    const { data: admins } = await admin
      .schema("core")
      .from<{ user_id: string }>("profiles")
      .select("user_id")
      .eq("role", "super_admin")
      .eq("status", "active");
    if ((admins ?? []).length <= 1) {
      throw new Error("This is the last active super admin — promote someone else first.");
    }
  }

  const { error } = await admin
    .schema("core")
    .from<{ status: string }>("profiles")
    .update({ status })
    .eq("user_id", userId);
  if (error) throw new Error(error.message);

  // Identity-provider side: invalidates the live session and blocks sign-in.
  // See setSupabaseUserBanned's comment for why the status flag alone isn't
  // enough.
  await setSupabaseUserBanned(userId, status === "disabled");

  await writeAudit(admin, caller, "status.change", { userId, fullName: profile.full_name }, {
    from: profile.status,
    to: status,
  });
}

/**
 * Writes per-user permission overrides in the unified key space (0079) —
 * pages (`network.view`) and features (`network.agent_sales.view`) alike.
 * Supersedes updateUserPageOverrides below, which only ever handled pages.
 *
 * `null` clears an override (deletes the row, deferring back to the role
 * default); `true`/`false` writes an explicit grant/revoke. Delete-then-insert
 * for the touched keys only, same shape and same reasoning as
 * updateUserStoreAccess: this is an infrequent admin write, not a hot path.
 */
export async function updateUserPermissionOverrides(
  userId: string,
  overrides: Record<string, boolean | null>
): Promise<void> {
  const caller = await requireSuperAdminCaller();

  const keys = Object.keys(overrides);
  if (keys.length === 0) return;

  const admin = await createAdminClient();

  // Only keys that actually exist in the registry — stops a malformed or
  // stale client from writing rows the resolver would never read.
  const { data: known } = await admin
    .schema("core")
    .from<{ key: string }>("feature_keys")
    .select("key")
    .in("key", keys);
  const knownKeys = new Set((known ?? []).map((k) => k.key));
  const valid = keys.filter((k) => knownKeys.has(k));
  if (valid.length === 0) return;

  const profile = await loadProfile(admin, userId);

  const { error: deleteError } = await admin
    .schema("core")
    .from<{ user_id: string; permission_key: string }>("user_permission_overrides")
    .delete()
    .eq("user_id", userId)
    .in("permission_key", valid);
  if (deleteError) throw new Error(deleteError.message);

  const rows = valid
    .filter((k) => overrides[k] === true || overrides[k] === false)
    .map((k) => ({ user_id: userId, permission_key: k, allowed: overrides[k] as boolean }));

  if (rows.length > 0) {
    const { error: insertError } = await admin
      .schema("core")
      .from<{ user_id: string; permission_key: string; allowed: boolean }>("user_permission_overrides")
      .insert(rows);
    if (insertError) throw new Error(insertError.message);
  }

  await writeAudit(
    admin,
    caller,
    "permissions.change",
    { userId, fullName: profile?.full_name },
    {
      allowed: valid.filter((k) => overrides[k] === true),
      denied: valid.filter((k) => overrides[k] === false),
      cleared: valid.filter((k) => overrides[k] === null),
    }
  );

  // Permit stays PAGE-level only (see the plan's decision): it has no deny
  // primitive, so extending it to features would mean a synthesized role per
  // user carrying an ~80-entry permission list. Feature overrides are a
  // Postgres-only concern.
  await syncPermitOverridesForUser(admin, userId);
}

/**
 * @deprecated Superseded by updateUserPermissionOverrides() (0079), which
 * covers pages AND features in one key space. Kept only until the old
 * page-access UI is fully removed; it still writes core.user_page_overrides,
 * which nothing reads anymore.
 */
export async function updateUserPageOverrides(
  userId: string,
  overrides: Partial<Record<PageKey, boolean | null>>
): Promise<void> {
  const caller = await requireSuperAdminCaller();
  void caller;

  const keys = (Object.keys(overrides) as PageKey[]).filter((k) => PAGE_KEYS.includes(k));
  if (keys.length === 0) return;

  const admin = await createAdminClient();

  const { error: deleteError } = await admin
    .schema("core")
    .from<{ user_id: string; page_key: string }>("user_page_overrides")
    .delete()
    .eq("user_id", userId)
    .in("page_key", keys);
  if (deleteError) throw new Error(deleteError.message);

  const rows = keys
    .filter((k) => overrides[k] === true || overrides[k] === false)
    .map((k) => ({ user_id: userId, page_key: k, allowed: overrides[k] as boolean }));

  if (rows.length > 0) {
    const { error: insertError } = await admin
      .schema("core")
      .from<{ user_id: string; page_key: string; allowed: boolean }>("user_page_overrides")
      .insert(rows);
    if (insertError) throw new Error(insertError.message);
  }

  await syncPermitOverridesForUser(admin, userId);
}
