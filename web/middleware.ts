import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Run on everything except static assets, Next internals, and
     * /sh-test — the Keycloak/PostgREST proving ground, which deliberately
     * uses its own separate session mechanism and isn't part of the
     * production auth flow. Remove this exclusion once /sh-test is deleted.
     * Role-based routing (layer 2) happens in each route group's layout.tsx,
     * not here — this file only knows "logged in or not".
     *
     * Also excludes api/cron/* — Vercel Cron calls these with no Supabase
     * session cookie at all (auth is the route's own CRON_SECRET check, see
     * app/api/cron/uniware-sync/route.ts), so this middleware redirecting
     * every unauthenticated request to /login would 307 every real cron
     * invocation before its own auth check ever ran — confirmed live
     * (2026-08-22): without this exclusion the route always returned a
     * /login redirect, never the JSON response.
     */
    "/((?!_next/static|_next/image|favicon.ico|sh-test|api/cron|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
