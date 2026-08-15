import "server-only";
import { getValidAccessToken } from "@/lib/keycloak/session";
import { createPostgrestClient } from "./client";

/**
 * Self-hosted equivalent of lib/supabase/server.ts's createClient() —
 * reads the caller's session (refreshing if needed) and returns a client
 * scoped to that user, same shape as the Supabase original:
 * `(await createClient()).schema('core').from('stores').select('*')`.
 */
export async function createClient() {
  const session = await getValidAccessToken();
  return createPostgrestClient(session?.accessToken ?? null);
}
