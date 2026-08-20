import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

/**
 * RLS-scoped Supabase client for Server Components/Actions — reads the
 * caller's session from cookies (managed by `@supabase/ssr`, refreshed in
 * `middleware.ts`) and issues every query as that user, so
 * `core.current_user_id()` (now `select auth.uid()`, migration 0060)
 * resolves to the real signed-in user and RLS scopes accordingly.
 *
 * Same call shape the self-hosted equivalent (`lib/postgrest/server.ts`,
 * now retired) was itself modeled on: `(await createClient()).schema('core')
 * .from('stores').select('*')`. `lib/data/client.ts` re-exports this under
 * the app-wide `DataClient` type so no call site needed to change.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component render (not a Server Action/Route
            // Handler) — cookies() is read-only there. Harmless: middleware.ts
            // already refreshes the session on every request, so a component
            // render skipping a cookie write just means that one refresh
            // happens one request later instead.
          }
        },
      },
    }
  );
}
