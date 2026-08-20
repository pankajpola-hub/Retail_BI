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
     */
    "/((?!_next/static|_next/image|favicon.ico|sh-test|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
