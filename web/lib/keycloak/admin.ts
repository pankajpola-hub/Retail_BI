import "server-only";
import { keycloakConfig } from "./config";

/**
 * Keycloak Admin API calls for user provisioning — the self-hosted
 * counterpart to Supabase's `admin.auth.admin.inviteUserByEmail()`.
 *
 * NOT WIRED UP YET. This needs a Keycloak client with realm-management
 * permissions (manage-users), which is a different client from both
 * ebo-api (end-user login) and the service-account client PostgREST uses.
 * Until that's configured, createKeycloakUser() throws rather than
 * half-provisioning a user — a user row in core.profiles with no matching
 * Keycloak account is worse than a clean failure, because the invite looks
 * like it worked and the person simply can never log in.
 *
 * When building this out, note the ordering constraint that already exists
 * on the Supabase side: the Keycloak user must be created FIRST, because
 * core.profiles.user_id has to match Keycloak's generated user id — that's
 * the join the whole RLS model depends on (see core.current_user_id()).
 */
async function getAdminToken(): Promise<string> {
  const clientId = process.env.SELFHOSTED_KEYCLOAK_ADMIN_CLIENT_ID;
  const clientSecret = process.env.SELFHOSTED_KEYCLOAK_ADMIN_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "Self-hosted user provisioning isn't configured yet — set " +
        "SELFHOSTED_KEYCLOAK_ADMIN_CLIENT_ID / _SECRET and grant that client " +
        "realm-management/manage-users (see lib/keycloak/admin.ts)."
    );
  }

  const res = await fetch(keycloakConfig.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
    cache: "no-store",
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error_description || data.error || "Keycloak admin token request failed.");
  }
  return data.access_token;
}

/**
 * Creates a Keycloak user and returns its id.
 *
 * DELIBERATELY NO requiredActions — see the incident note on
 * resetKeycloakUserPassword() below. Keycloak REFUSES the resource-owner
 * password grant (grant_type=password), which is the ONLY login path this app
 * implements (lib/keycloak/session.ts loginWithPassword), for any account
 * carrying a pending required action — it returns error_description
 * "Account is not fully set up". Since nothing in this app can clear a
 * Keycloak required action (/set-password talks to Supabase's auth API, not
 * Keycloak, so it is a no-op here), setting UPDATE_PASSWORD at creation time
 * made every newly invited user permanently unable to log in.
 *
 * The user is still created without a password; the admin sets one via the
 * Users page's Reset password button and passes it on out of band (no email
 * is sent — Keycloak's SMTP isn't configured on this realm). Forcing a
 * self-chosen password on first login needs either Keycloak's hosted login
 * page (authorization-code flow) or a real Keycloak-aware set-password
 * screen; until one of those exists, this must not set requiredActions.
 */
export async function createKeycloakUser(email: string, fullName: string): Promise<string> {
  const token = await getAdminToken();
  const [firstName, ...rest] = fullName.trim().split(/\s+/);

  const res = await fetch(`${keycloakConfig.baseUrl}/admin/realms/${keycloakConfig.realm}/users`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      username: email,
      email,
      firstName: firstName ?? email,
      lastName: rest.join(" ") || "",
      enabled: true,
      emailVerified: false,
      requiredActions: [],
    }),
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Keycloak user creation failed (${res.status}): ${body}`);
  }

  // Keycloak returns the new user's id only in the Location header, not the body.
  const location = res.headers.get("location");
  const id = location?.split("/").pop();
  if (!id) throw new Error("Keycloak created the user but returned no id.");
  return id;
}

/**
 * Updates a Keycloak user's firstName/lastName so it stays in sync with
 * core.profiles.full_name after an admin rename (see users/actions.ts
 * renameUser). Splits on the same "first word / rest" convention
 * createKeycloakUser() uses so a round-trip rename produces the same
 * firstName/lastName split it would have at invite time. Keycloak has no
 * single "display name" field — firstName + lastName is the closest
 * equivalent, and is what shows up in the Keycloak admin console and any
 * token claims that map to it.
 */
export async function updateKeycloakUserName(userId: string, fullName: string): Promise<void> {
  const token = await getAdminToken();
  const [firstName, ...rest] = fullName.trim().split(/\s+/);

  const res = await fetch(`${keycloakConfig.baseUrl}/admin/realms/${keycloakConfig.realm}/users/${userId}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      firstName: firstName ?? fullName,
      lastName: rest.join(" ") || "",
    }),
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Keycloak user update failed (${res.status}): ${body}`);
  }
}

/**
 * Sets a Keycloak user's password to an admin-chosen value, replacing
 * whatever password was there before. core.profiles.user_id IS the Keycloak
 * user id (see the join comment on createKeycloakUser), so callers pass that
 * straight through.
 *
 * INCIDENT — why `temporary: false`, and why it must stay that way:
 * this originally passed `temporary: true`, which sets an UPDATE_PASSWORD
 * required action on the credential. Keycloak then refuses grant_type=password
 * for that account entirely, responding with error_description
 * "Account is not fully set up" — no token, no login, no way through. The app
 * only implements the resource-owner password grant (lib/keycloak/session.ts),
 * and has no Keycloak-aware screen that can clear a required action
 * (/set-password calls Supabase's auth API and does nothing on this backend),
 * so there was no path out: using the Users page's own "Reset password" button
 * on an account permanently locked that account out of the app. It did exactly
 * that to the super_admin account, and the raw Keycloak error surfaced on the
 * login page as "Account is not fully set up" — indistinguishable at a glance
 * from the app's own not_provisioned copy, which sent the first round of
 * diagnosis down entirely the wrong path.
 *
 * Do NOT reintroduce `temporary: true` (or requiredActions anywhere) without
 * first building a login path that can satisfy a required action — i.e.
 * switching to Keycloak's hosted login page / authorization-code flow, or a
 * genuine Keycloak set-password screen.
 */
export async function setKeycloakUserPassword(userId: string, newPassword: string): Promise<void> {
  const token = await getAdminToken();

  const res = await fetch(
    `${keycloakConfig.baseUrl}/admin/realms/${keycloakConfig.realm}/users/${userId}/reset-password`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "password", value: newPassword, temporary: false }),
      cache: "no-store",
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Keycloak password reset failed (${res.status}): ${body}`);
  }
}
