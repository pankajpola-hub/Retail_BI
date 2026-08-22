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
    {
      auth: { autoRefreshToken: false, persistSession: false },
      // Next.js's patched global fetch caches requests by default — confirmed
      // live (2026-08-22) to bite even a same-shape POST .rpc() call made
      // more than once with different arguments within one request: an
      // RPC call with p_limit=150 silently returned a cached empty result
      // while the identical call outside Next (or with p_limit=5) returned
      // real rows. An admin client exists specifically to make fresh,
      // authoritative writes/reads — it must never serve a cached response.
      global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }) },
    }
  );
}
