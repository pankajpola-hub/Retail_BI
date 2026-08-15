import { NextResponse, type NextRequest } from "next/server";
import { keycloakConfig } from "./config";

const ACCESS_COOKIE = "sh_access_token";
const REFRESH_COOKIE = "sh_refresh_token";

function decodeExp(token: string): number | null {
  try {
    const parts = token.split(".");
    if (!parts[1]) return null;
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(atob(padded)).exp ?? null;
  } catch {
    return null;
  }
}

/**
 * Self-hosted equivalent of lib/supabase/middleware.ts's updateSession —
 * same shape, same redirect rules, different token source. Middleware runs
 * on the Edge runtime, so this can't reuse lib/keycloak/session.ts (which
 * uses next/headers's cookies() and Node's Buffer) — request.cookies +
 * atob() instead.
 */
export async function updateSelfHostedSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const access = request.cookies.get(ACCESS_COOKIE)?.value;
  const refresh = request.cookies.get(REFRESH_COOKIE)?.value;

  let hasValidSession = false;

  if (access) {
    const exp = decodeExp(access);
    if (exp && exp * 1000 > Date.now() + 30_000) {
      hasValidSession = true;
    }
  }

  if (!hasValidSession && refresh) {
    try {
      const res = await fetch(keycloakConfig.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: keycloakConfig.clientId,
          client_secret: keycloakConfig.clientSecret,
          grant_type: "refresh_token",
          refresh_token: refresh,
        }).toString(),
      });
      if (res.ok) {
        const tokens = await res.json();
        request.cookies.set(ACCESS_COOKIE, tokens.access_token);
        response = NextResponse.next({ request });
        const common = { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/" };
        response.cookies.set(ACCESS_COOKIE, tokens.access_token, { ...common, maxAge: tokens.expires_in });
        response.cookies.set(REFRESH_COOKIE, tokens.refresh_token, { ...common, maxAge: 60 * 60 * 24 * 7 });
        hasValidSession = true;
      } else {
        // Logged (not swallowed) because a refresh failure here silently
        // logs the user out with no client-side error — see the incident
        // this comment came from: keycloakConfig.baseUrl was a bare IP
        // literal, which Vercel's Edge runtime rejects outright ("Direct IP
        // access is not allowed in Vercel's Edge environment") on every
        // single fetch from this file specifically, because this is the one
        // module in the app that runs on Edge rather than Node — see the
        // file header comment. lib/keycloak/session.ts's refresh (Node
        // runtime) was never affected, so this failure mode only ever
        // showed up as "logged out while navigating," never on login itself.
        console.error(
          `[keycloak/middleware] refresh_token grant failed: ${res.status} ${await res.text().catch(() => "")}`
        );
      }
    } catch (err) {
      console.error(`[keycloak/middleware] refresh_token grant threw: ${String(err)}`);
      // Keycloak unreachable or refresh token expired — falls through to
      // the redirect below, same as "no session" from the caller's view.
    }
  }

  // /sh-test never reaches here at all — middleware.ts's matcher excludes
  // it outright (see that file's comment), so no exemption needed for it.
  const path = request.nextUrl.pathname;
  const isProtected = !path.startsWith("/login");

  if (!hasValidSession && isProtected) {
    const redirectUrl = new URL("/login", request.url);
    redirectUrl.searchParams.set("next", path);
    return NextResponse.redirect(redirectUrl);
  }

  return response;
}
