"use server";

import { clearSessionCookies } from "@/lib/keycloak/session";

/**
 * Sign-out. SignOutButton is a Client Component and can't touch cookies()
 * directly, so this Server Action does it.
 */
export async function signOutAction() {
  await clearSessionCookies();
}
