import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Session refresh for the Edge middleware — same shape/redirect rules as the
 * self-hosted equivalent this replaces (`lib/keycloak/middleware.ts`'s
 * `updateSelfHostedSession`, now retired): read the cookie session, refresh
 * if needed, redirect to /login if there's no valid session on a protected
 * route. `@supabase/ssr`'s `getUser()` does the token-refresh-if-needed
 * itself (unlike the self-hosted version's manual exp-check + refresh
 * grant), so this is simpler than what it replaces.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        },
      },
    }
  );

  // getUser() (not getSession()) — verifies the token against Supabase
  // rather than trusting whatever's in the cookie, and refreshes it via the
  // cookie adapter above if it's expired.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // /sh-test is excluded by middleware.ts's own matcher, same as before.
  const path = request.nextUrl.pathname;
  const isProtected = !path.startsWith("/login");

  if (!user && isProtected) {
    const redirectUrl = new URL("/login", request.url);
    redirectUrl.searchParams.set("next", path);
    return NextResponse.redirect(redirectUrl);
  }

  return response;
}
