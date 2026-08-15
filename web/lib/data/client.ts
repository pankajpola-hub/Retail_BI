import "server-only";
import { createClient as createPostgrestClient } from "@/lib/postgrest/server";
import type { PostgrestResult } from "@/lib/postgrest/client";

/**
 * The subset of the chainable query surface actually used across this
 * codebase (schema/from/select/eq/gte/lte/in/order/limit/single/maybeSingle/
 * upsert/insert/update/delete/rpc/auth.getUser).
 *
 * This interface predates the Supabase removal, when it existed to reconcile
 * two structurally-similar-but-unrelated client types. Only the self-hosted
 * PostgREST client remains, but the interface is kept as the explicit
 * contract every page/route codes against — extend it if something needs a
 * method not listed, rather than casting around it call-site by call-site.
 */
// Terminal chain after .single()/.maybeSingle() — resolves to ONE row (or
// null), not an array, and offers no further filter methods.
export interface SingleQueryChain<T> extends PromiseLike<PostgrestResult<T>> {}

export interface QueryChain<T = unknown> extends PromiseLike<PostgrestResult<T[]>> {
  select(cols?: string): QueryChain<T>;
  eq(col: string, val: unknown): QueryChain<T>;
  neq(col: string, val: unknown): QueryChain<T>;
  gt(col: string, val: unknown): QueryChain<T>;
  gte(col: string, val: unknown): QueryChain<T>;
  lt(col: string, val: unknown): QueryChain<T>;
  lte(col: string, val: unknown): QueryChain<T>;
  in(col: string, vals: unknown[]): QueryChain<T>;
  order(col: string, opts?: { ascending?: boolean }): QueryChain<T>;
  limit(n: number): QueryChain<T>;
  single(): SingleQueryChain<T>;
  maybeSingle(): SingleQueryChain<T>;
  insert(row: Record<string, unknown> | Record<string, unknown>[]): QueryChain<T>;
  upsert(
    row: Record<string, unknown> | Record<string, unknown>[],
    opts?: { onConflict?: string }
  ): QueryChain<T>;
  update(row: Record<string, unknown>): QueryChain<T>;
  delete(): QueryChain<T>;
}

export interface DataClient {
  schema(name: string): {
    from<T = unknown>(table: string): QueryChain<T>;
    rpc<T = unknown>(fnName: string, args?: Record<string, unknown>): Promise<PostgrestResult<T>>;
  };
  auth: {
    getUser(): Promise<{ data: { user: { id: string; email: string | null } | null } }>;
  };
}

/**
 * The app's data client — the self-hosted stack (Keycloak-issued JWT ->
 * PostgREST -> Postgres on the in-house server). Supabase was removed
 * entirely; there is no longer a second backend or a toggle between them.
 */
export async function createClient(): Promise<DataClient> {
  return (await createPostgrestClient()) as unknown as DataClient;
}
