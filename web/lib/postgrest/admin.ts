import "server-only";
import { createPostgrestClient } from "./client";
import { keycloakConfig } from "@/lib/keycloak/config";

/**
 * Self-hosted equivalent of lib/supabase/admin.ts — the service_role client
 * that bypasses RLS. Same restricted import list applies; see that file's
 * header for which callers are allowed to touch it and why.
 *
 * Getting a service_role JWT is genuinely different from Supabase here.
 * Supabase hands you a static, pre-signed service_role key. Keycloak has no
 * such thing — the equivalent is a client-credentials grant against a
 * confidential client, producing a short-lived token whose "role" claim
 * PostgREST maps to the service_role Postgres role (created in migration
 * 0021 for exactly this).
 *
 * NOT WIRED UP YET — this needs a dedicated Keycloak client (separate from
 * ebo-api, which is the end-user login client) with a hardcoded role=service_role
 * claim mapper and service-accounts enabled. Until that exists,
 * createAdminClient() below throws rather than silently falling back to a
 * user-scoped client, which would look like it worked while quietly being
 * RLS-blocked (or worse, succeeding for a super_admin and failing for
 * everyone else).
 */
export async function createAdminClient() {
  const clientId = process.env.SELFHOSTED_KEYCLOAK_SERVICE_CLIENT_ID;
  const clientSecret = process.env.SELFHOSTED_KEYCLOAK_SERVICE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "Self-hosted service-role access isn't configured yet — set " +
        "SELFHOSTED_KEYCLOAK_SERVICE_CLIENT_ID / _SECRET and create the matching " +
        "Keycloak service-account client (see lib/postgrest/admin.ts)."
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
    throw new Error(data.error_description || data.error || "Service-role token request failed.");
  }

  return createPostgrestClient(data.access_token);
}
