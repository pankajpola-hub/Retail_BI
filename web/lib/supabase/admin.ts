import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client — bypasses RLS (Supabase's `service_role`
 * ships with BYPASSRLS by default; confirmed live, see migration 0045's
 * header for the self-hosted equivalent that had to grant this manually).
 * No cookies — this doesn't act as any particular signed-in user, so it's a
 * plain client, not the cookie-based `createServerClient` in `server.ts`.
 *
 * Same restricted-import posture as the self-hosted admin client it
 * replaces (`lib/postgrest/admin.ts`, now retired): user provisioning
 * (`app/(admin)/users/actions.ts`) and the integrations credential write.
 * If you're importing this from anywhere else, the query almost certainly
 * belongs behind the caller's own session (`lib/data/client.ts`) with an
 * RLS policy doing the actual gating.
 */
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}
