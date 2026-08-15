import "server-only";

/**
 * Self-hosted stack config. DATA_BACKEND=selfhosted is set on Vercel
 * Production (as of the Keycloak cutover), so these ARE live in production,
 * not just .env.local — update this comment's origin (this used to say
 * otherwise) if you're relying on it to reason about what's deployed.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

// Vercel's Edge runtime — which is what runs lib/keycloak/middleware.ts,
// the one module in this app that isn't plain Node — refuses to fetch a
// bare IP literal ("Direct IP access is not allowed in Vercel's Edge
// environment"), while every other runtime (Node, curl, browsers) fetches
// an IP fine. SELFHOSTED_KEYCLOAK_URL was configured as
// "http://<public-ip>:8180" — reachable from everywhere except the one
// place that mattered. The failure was caught and treated as "no session,"
// which is why this showed up as users getting logged out minutes into
// using the app rather than as a visible error: the access-token cookie's
// short still-valid window covered the first request or two after login,
// then every refresh attempt from middleware silently failed forever.
// Rewriting a bare IPv4 host to "<ip>.nip.io" (wildcard DNS that resolves
// back to the same IP — same trick as sslip.io) gives Edge a real hostname
// to resolve without touching the server or the Vercel env var itself.
const IPV4_HOST = /^(https?:\/\/)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?=[:/]|$)/;

function edgeSafeUrl(url: string): string {
  return url.replace(IPV4_HOST, "$1$2.nip.io");
}

export const keycloakConfig = {
  get baseUrl() {
    return edgeSafeUrl(required("SELFHOSTED_KEYCLOAK_URL"));
  },
  get realm() {
    return required("SELFHOSTED_KEYCLOAK_REALM");
  },
  get clientId() {
    return required("SELFHOSTED_KEYCLOAK_CLIENT_ID");
  },
  get clientSecret() {
    return required("SELFHOSTED_KEYCLOAK_CLIENT_SECRET");
  },
  get tokenEndpoint() {
    return `${this.baseUrl}/realms/${this.realm}/protocol/openid-connect/token`;
  },
  get logoutEndpoint() {
    return `${this.baseUrl}/realms/${this.realm}/protocol/openid-connect/logout`;
  },
};

export const postgrestConfig = {
  get baseUrl() {
    return required("SELFHOSTED_POSTGREST_URL");
  },
};
