"use server";

import { loginWithPassword, setSessionCookies, clearSessionCookies } from "@/lib/keycloak/session";

/**
 * Test-only actions for /_sh-test — verifying the self-hosted Keycloak +
 * PostgREST path works before any real page gets rewired to use it. Not
 * linked from nav, not part of the production auth flow.
 */
export async function testLogin(email: string, password: string) {
  const tokens = await loginWithPassword(email, password);
  await setSessionCookies(tokens);
}

export async function testLogout() {
  await clearSessionCookies();
}
