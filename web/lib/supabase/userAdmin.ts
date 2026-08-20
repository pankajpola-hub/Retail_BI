import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Supabase Auth Admin API calls for user provisioning — replaces
 * lib/keycloak/admin.ts (retired), which never got wired up
 * ("NOT WIRED UP YET" — no working invite flow existed before this).
 *
 * Same ordering constraint the Keycloak version documented: the identity
 * provider user must be created FIRST, because core.profiles.user_id has to
 * match its generated id — that's the join core.current_user_id()
 * (migration 0060, `select auth.uid()`) and the whole RLS model depend on.
 *
 * 2026-08-20: password is now set AT creation, not as a required separate
 * "Reset password" step afterward. The original two-step design (create
 * with no password, admin resets it after) was a direct port of the
 * Keycloak version's own workaround for a REAL Keycloak-specific bug
 * (setting a password at creation there implied a required action that
 * permanently locked the account out — see the retired lib/keycloak/admin.ts's
 * incident note). Supabase has no such lockout behavior; `createUser` with a
 * password produces an account immediately usable with
 * `signInWithPassword`, no separate step. Keeping the two-step version here
 * would have been carrying over someone else's platform's bug as if it
 * were still a constraint.
 */
export async function createSupabaseUser(email: string, fullName: string, password: string): Promise<string> {
  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // no SMTP on this project — skip the confirmation-email step entirely
    user_metadata: { full_name: fullName },
  });
  if (error) throw new Error(`Supabase user creation failed: ${error.message}`);
  if (!data.user) throw new Error("Supabase created the user but returned no id.");
  return data.user.id;
}

/**
 * Keeps auth.users' user_metadata.full_name in sync after an admin rename
 * (users/actions.ts renameUser) — cosmetic only. core.profiles.full_name is
 * the actual source of truth the app renders everywhere; Supabase has no
 * separate firstName/lastName split the way Keycloak did, so this is a
 * single free-form field.
 */
export async function updateSupabaseUserName(userId: string, fullName: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.auth.admin.updateUserById(userId, { user_metadata: { full_name: fullName } });
  if (error) throw new Error(`Supabase user update failed: ${error.message}`);
}

/**
 * Sets a user's password to an admin-chosen value, replacing whatever was
 * there before. No `temporary`/required-action concept on Supabase (that
 * was a Keycloak-specific footgun — see the retired lib/keycloak/admin.ts's
 * incident note) — a password set this way is immediately usable for
 * `signInWithPassword`, no separate confirmation step.
 */
export async function setSupabaseUserPassword(userId: string, newPassword: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.auth.admin.updateUserById(userId, { password: newPassword });
  if (error) throw new Error(`Supabase password reset failed: ${error.message}`);
}
