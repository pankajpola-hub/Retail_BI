"use server";

import { z } from "zod";
import { createClient } from "@/lib/data/client";
import { createAdminClient } from "@/lib/data/admin";
import { createKeycloakUser, setKeycloakUserPassword, updateKeycloakUserName } from "@/lib/keycloak/admin";
import type { AppRole, PageKey } from "@/lib/auth/roles";
import { PAGE_KEYS } from "@/lib/auth/roles";

const inviteSchema = z.object({
  email: z.string().email(),
  fullName: z.string().min(1),
  role: z.enum(["super_admin", "ho_admin", "regional_manager", "ebo_manager", "marketing"]),
  storeIds: z.array(z.string()),
});

/**
 * The one place in the app that provisions a user — see
 * docs/rbac-auth-setup.md §1. Two checks before any admin client is
 * constructed: the caller's own session must resolve to super_admin
 * (re-checked here, independent of whatever got them past the (admin)
 * layout gate — Server Actions are directly callable and must not assume
 * the layout ran), and only then does provisioning start.
 *
 * Identity is created in Keycloak via its Admin API; no email is sent (the
 * realm has no SMTP configured), so the admin sets a password via the Reset
 * password button and passes it on out of band. What follows is the
 * core.profiles row and core.user_store_access grants, keyed on the Keycloak
 * user id — that id IS the join the entire RLS model rests on.
 */
export async function inviteUser(input: z.infer<typeof inviteSchema>) {
  const { email, fullName, role, storeIds } = inviteSchema.parse(input);

  const supabase = await createClient();
  const {
    data: { user: caller },
  } = await supabase.auth.getUser();
  if (!caller) throw new Error("Not authenticated.");

  const { data: callerProfile } = await supabase
    .schema("core")
    .from<{ role: AppRole }>("profiles")
    .select("role")
    .eq("user_id", caller.id)
    .single();

  if (callerProfile?.role !== "super_admin") {
    throw new Error("Only super_admin can invite users.");
  }

  // Identity first — core.profiles.user_id must match the identity
  // provider's id, so a failure here must abort before any DB row is
  // written rather than leave a profile pointing at nothing.
  const newUserId = await createKeycloakUser(email, fullName);

  const admin = await createAdminClient();

  const { error: profileError } = await admin
    .schema("core")
    .from<{ user_id: string; full_name: string; role: AppRole }>("profiles")
    .insert({ user_id: newUserId, full_name: fullName, role });
  if (profileError) throw new Error(profileError.message);

  if (storeIds.length > 0) {
    const { error: grantError } = await admin
      .schema("core")
      .from<{ user_id: string; store_id: string }>("user_store_access")
      .insert(storeIds.map((store_id) => ({ user_id: newUserId, store_id })));
    if (grantError) throw new Error(grantError.message);
  }
}

/**
 * Sets an existing user's Keycloak password to an admin-chosen value,
 * replacing whatever was there before — same re-check-the-caller pattern as
 * inviteUser above, since Server Actions are directly callable regardless of
 * whether the (admin) layout's requireRole("super_admin") ran. Nothing is
 * generated or returned; the admin types the new password themselves and
 * hands it to the user out of band (no email — Keycloak's SMTP isn't
 * configured on this realm).
 *
 * The password is set as NON-temporary — see the incident note on
 * setKeycloakUserPassword() in lib/keycloak/admin.ts for why a temporary one
 * locks the account out of this app entirely.
 */
export async function setUserPassword(userId: string, newPassword: string): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user: caller },
  } = await supabase.auth.getUser();
  if (!caller) throw new Error("Not authenticated.");

  const { data: callerProfile } = await supabase
    .schema("core")
    .from<{ role: AppRole }>("profiles")
    .select("role")
    .eq("user_id", caller.id)
    .single();

  if (callerProfile?.role !== "super_admin") {
    throw new Error("Only super_admin can set passwords.");
  }

  if (newPassword.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }

  await setKeycloakUserPassword(userId, newPassword);
}

// Same "re-check the caller regardless of whether the (admin) layout's
// requireRole('super_admin') already ran" reasoning as resetUserPassword
// above — Server Actions are directly callable. Factored out here (the
// three actions above predate this helper and are left as-is rather than
// churned for a pure refactor) so renameUser/updateUserStoreAccess/
// updateUserPageOverrides don't each re-duplicate the lookup a fourth time.
async function requireSuperAdminCaller(): Promise<string> {
  const supabase = await createClient();
  const {
    data: { user: caller },
  } = await supabase.auth.getUser();
  if (!caller) throw new Error("Not authenticated.");

  const { data: callerProfile } = await supabase
    .schema("core")
    .from<{ role: AppRole }>("profiles")
    .select("role")
    .eq("user_id", caller.id)
    .single();

  if (callerProfile?.role !== "super_admin") {
    throw new Error("Only super_admin can manage users.");
  }

  return caller.id;
}

/**
 * User feedback #15 ("give me option to rename the users in users page"):
 * updates the Keycloak firstName/lastName and core.profiles.full_name —
 * same pattern as createKeycloakUser/resetKeycloakUserPassword: identity
 * provider first, core.profiles second, both keyed on the same user_id.
 */
export async function renameUser(userId: string, fullName: string): Promise<void> {
  await requireSuperAdminCaller();

  const trimmed = fullName.trim();
  if (!trimmed) throw new Error("Name can't be empty.");

  await updateKeycloakUserName(userId, trimmed);

  const admin = await createAdminClient();
  const { error } = await admin
    .schema("core")
    .from<{ full_name: string }>("profiles")
    .update({ full_name: trimmed })
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
}

/**
 * User feedback #16a ("allocate the location"): replaces a user's full set
 * of core.user_store_access grants (migration 0003) with storeIds. Store
 * access only matters for ebo_manager/regional_manager — core.fn_user_store_ids()
 * returns every store for ho_admin/super_admin regardless — but this
 * doesn't restrict by role: an admin re-provisioning someone into a
 * store-scoped role later shouldn't need a separate first-time setup path.
 * Delete-then-insert rather than a diff, same tradeoff inviteUser already
 * makes implicitly (insert-only on a fresh user): simpler than computing
 * add/remove sets, at the cost of a moment where the user has zero grants
 * mid-transaction-less-round-trip. Acceptable here — this is an infrequent
 * admin action, not a hot path, and a mid-update read just sees "no stores"
 * briefly rather than stale or duplicated grants.
 */
export async function updateUserStoreAccess(userId: string, storeIds: string[]): Promise<void> {
  await requireSuperAdminCaller();

  const admin = await createAdminClient();

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
export async function updateUserPageOverrides(
  userId: string,
  overrides: Partial<Record<PageKey, boolean | null>>
): Promise<void> {
  await requireSuperAdminCaller();

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
}
