import "server-only";
import { createAdminClient as createSupabaseAdmin } from "@/lib/supabase/admin";
import type { DataClient } from "./client";

/**
 * Service-role client — bypasses RLS (real Supabase `service_role`, migrated
 * 2026-08-20). Restricted import list, and this is the whole list: user
 * provisioning (app/(admin)/users/actions.ts) and the integrations
 * credential write. If you're importing this from anywhere else, stop — the
 * query almost certainly belongs behind the caller's own session
 * (lib/data/client.ts) with an RLS policy doing the actual gating.
 */
export async function createAdminClient(): Promise<DataClient> {
  return createSupabaseAdmin() as unknown as DataClient;
}
