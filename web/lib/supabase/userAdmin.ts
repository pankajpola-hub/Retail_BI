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
 * Same "no password at creation" posture as the Keycloak version, and for
 * the same reason: this realm has no email/SMTP configured, so there's no
 * invite-link flow to rely on. createUser() below creates the account with
 * NO password; the admin sets one via the Users page's existing "Reset
 * password" button (setSupabaseUserPassword), which already had to exist
 * for password changes regardless of how the user was created — no new UI
 * needed.
 */
export async function createSupabaseUser(email: string, fullName: string): Promise<string> {
  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.createUser({
    email,
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
