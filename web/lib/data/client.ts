import "server-only";
import { createClient as createSupabaseServerClient } from "@/lib/supabase/server";

export type PostgrestError = { code: string; message: string; details: string | null; hint: string | null };
export type PostgrestResult<T> = { data: T | null; error: PostgrestError | null };

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
  // Supabase's project "Max Rows" API setting silently caps EVERY query at
  // that value (1000 here) regardless of what .limit() asks for — a bare
  // .limit(40000) does not raise it, PostgREST just returns 1000 rows with
  // no error. .range() is the only way to get more: page through with it
  // rather than relying on .limit() alone once a result can plausibly
  // exceed 1000 rows. See lib/replenishment/mix.ts's fetchAllRows() for the
  // paging helper this enables — found live 2026-08-25 when Sale vs Stock
  // Mix's attribute views were silently missing ~95% of sale rows.
  range(from: number, to: number): QueryChain<T>;
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
 * The app's data client — real Supabase (2026-08-20 migration from the
 * self-hosted Keycloak/PostgREST stack). `DataClient` predates that move (it
 * originally existed to reconcile a Supabase client and a self-hosted one
 * behind one shape) and turns out to describe Supabase's own query builder
 * almost exactly (`.schema().from().select().eq()...`, `.auth.getUser()`),
 * so the real `@supabase/supabase-js` client satisfies it structurally —
 * this cast is the whole adapter, no per-method shim needed.
 */
export async function createClient(): Promise<DataClient> {
  return (await createSupabaseServerClient()) as unknown as DataClient;
}
