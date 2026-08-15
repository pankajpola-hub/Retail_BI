import "server-only";
import { cookies } from "next/headers";
import { keycloakConfig } from "./config";

const ACCESS_COOKIE = "sh_access_token";
const REFRESH_COOKIE = "sh_refresh_token";

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
};

type JwtClaims = {
  sub: string;
  exp: number;
  role?: string;
  preferred_username?: string;
  name?: string;
  email?: string;
};

export function decodeJwt(token: string): JwtClaims {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) throw new Error("Malformed JWT.");
  const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf-8"));
}

async function requestToken(body: Record<string, string>): Promise<TokenResponse> {
  const params = new URLSearchParams({
    client_id: keycloakConfig.clientId,
    client_secret: keycloakConfig.clientSecret,
    ...body,
  });
  const res = await fetch(keycloakConfig.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    cache: "no-store",
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error_description || data.error || "Login failed.");
  }
  return data;
}

/**
 * Resource-owner password grant — keeps the same login UX the app already
 * has (email + password on our own page), no redirect to Keycloak's hosted
 * login screen. Reasonable for an internal admin tool talking to a realm
 * this app controls; would need reconsidering for a consumer-facing app.
 */
export async function loginWithPassword(email: string, password: string): Promise<TokenResponse> {
  return requestToken({ grant_type: "password", username: email, password });
}

async function refreshTokens(refreshToken: string): Promise<TokenResponse> {
  return requestToken({ grant_type: "refresh_token", refresh_token: refreshToken });
}

/**
 * Only callable from a Route Handler or Server Action (Next.js forbids
 * writing cookies from a Server Component render) — same constraint
 * lib/supabase/server.ts already lives with.
 */
export async function setSessionCookies(tokens: TokenResponse) {
  const store = await cookies();
  const common = { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/" };
  store.set(ACCESS_COOKIE, tokens.access_token, { ...common, maxAge: tokens.expires_in });
  store.set(REFRESH_COOKIE, tokens.refresh_token, { ...common, maxAge: 60 * 60 * 24 * 7 });
}

export async function clearSessionCookies() {
  const store = await cookies();
  store.delete(ACCESS_COOKIE);
  store.delete(REFRESH_COOKIE);
}

/**
 * Reads the current session, transparently refreshing if the access token
 * is within 30s of expiring. Returns null if there's no session at all or
 * the refresh token has also expired — callers treat that as "not signed
 * in," same as Supabase's getUser() returning { user: null }.
 *
 * Like setSessionCookies, the refresh-and-rewrite path only works from a
 * Route Handler / Server Action; called from a Server Component render it
 * still returns a valid access token for that request, it just can't
 * persist the refreshed cookie (mirrors the existing Supabase pattern,
 * where middleware.ts is what keeps sessions alive across page loads).
 */
export async function getValidAccessToken(): Promise<{ accessToken: string; claims: JwtClaims } | null> {
  const store = await cookies();
  const access = store.get(ACCESS_COOKIE)?.value;
  const refresh = store.get(REFRESH_COOKIE)?.value;

  if (access) {
    const claims = decodeJwt(access);
    if (claims.exp * 1000 > Date.now() + 30_000) {
      return { accessToken: access, claims };
    }
  }

  if (!refresh) return null;

  try {
    const tokens = await refreshTokens(refresh);
    try {
      await setSessionCookies(tokens);
    } catch {
      // Server Component render — can't write cookies here, see header note.
    }
    return { accessToken: tokens.access_token, claims: decodeJwt(tokens.access_token) };
  } catch {
    return null;
  }
}
