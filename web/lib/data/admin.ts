import "server-only";
import { createAdminClient as createPostgrestAdmin } from "@/lib/postgrest/admin";
import type { DataClient } from "./client";

/**
 * Service-role client — bypasses RLS. Restricted import list, and this is the
 * whole list: user provisioning (app/(admin)/users/actions.ts) and the
 * integrations credential write. If you're importing this from anywhere else,
 * stop — the query almost certainly belongs behind the caller's own session
 * (lib/data/client.ts) with an RLS policy doing the actual gating.
 *
 * KNOWN GAP (see server/db/migrations/0045): the Keycloak service-account
 * client authenticates fine and PostgREST maps it to the service_role
 * Postgres role, but service_role has no table-level GRANTs on core.* on the
 * in-house database — so every write through this client currently fails with
 * 42501 "permission denied for table ...". Postgres checks GRANTs before RLS
 * is even considered, so bypassing RLS doesn't help without them. 0045 adds
 * the grants; it has to be applied on the server (psql), not from the app.
 */
export async function createAdminClient(): Promise<DataClient> {
  return (await createPostgrestAdmin()) as unknown as DataClient;
}
