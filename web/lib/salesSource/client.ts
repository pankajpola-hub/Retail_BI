import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Second, unrelated Supabase project — the ERP's live sale_detail view,
 * per Pankaj (2026-08-26). Deliberately separate from lib/data/client.ts
 * (this app's own Retail_BI project): no joins between the two, treated as
 * a second read-only source. Env vars are SALES_-prefixed with no
 * NEXT_PUBLIC_ (deliberately, per Pankaj's own note) — only ever read here,
 * server-side, never bundled into client JS.
 *
 * Module-scope singleton + a de-duped in-flight sign-in promise, per
 * Pankaj's own instruction: signing in inside the request handler on every
 * call gets rate-limited by Supabase. This signs in once and lets
 * supabase-js's own autoRefreshToken keep the session alive for as long as
 * this module instance stays warm — the same client/session is reused
 * across requests, not re-created per call. A concurrent burst of requests
 * on a cold instance all await the SAME sign-in call (signInPromise),
 * rather than each firing its own.
 */
// Wraps a Supabase Auth/PostgREST error without discarding its own
// code/details/hint — `throw new Error(error.message)` (the previous shape
// here) collapsed all three down to one string, which is exactly why the
// route's own catch block couldn't tell a sign-in failure from a query
// failure: both surfaced as the same bare, sometimes-empty `message`. Auth
// errors (AuthApiError) don't carry details/hint the way PostgrestError
// does — this reads whatever the real error actually has and leaves the
// rest undefined rather than inventing values.
export class SalesSourceError extends Error {
  phase: "sign_in" | "query";
  code?: string;
  details?: string;
  hint?: string;
  status?: number;
  constructor(phase: "sign_in" | "query", source: { message: string; code?: string; details?: string; hint?: string; status?: number }) {
    super(source.message || `sale_detail source ${phase} failed with no error message.`);
    this.name = "SalesSourceError";
    this.phase = phase;
    this.code = source.code;
    this.details = source.details;
    this.hint = source.hint;
    this.status = source.status;
  }
}

// A `head: true` (count-only) request has, by HTTP spec, NO response body —
// but supabase-js's PostgrestBuilder still tries to parse one, and on an
// empty body that parse can produce an error-SHAPED object with nothing
// real in it (message/code/details/hint all empty), rather than either a
// clean success or a real PostgrestError. Confirmed 2026-08-26: Pankaj
// verified sign-in and the sale_detail grant directly over REST (206,
// Content-Range: 0-0/23919) while this route was still failing with "no
// error message" — the empty-body-on-a-count-request artifact, not a real
// auth/query failure. Treating ANY truthy `error` as fatal (the previous
// behavior here) meant this artifact silently ate a successful count. Only
// an error that actually carries a message/code/details/hint is real.
export function isRealError(error: unknown): error is { message: string; code?: string; details?: string; hint?: string; status?: number } {
  if (!error || typeof error !== "object") return false;
  const e = error as Record<string, unknown>;
  return Boolean(e.message || e.code || e.details || e.hint);
}

let client: SupabaseClient | null = null;
let signInPromise: Promise<void> | null = null;

function getClient(): SupabaseClient {
  if (!client) {
    const url = process.env.SALES_SUPABASE_URL;
    const key = process.env.SALES_SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) throw new Error("SALES_SUPABASE_URL / SALES_SUPABASE_PUBLISHABLE_KEY are not set.");
    client = createClient(url, key, {
      auth: {
        // No browser storage on the server to persist into — irrelevant to
        // whether the in-memory session auto-refreshes, which is what
        // actually matters for a warm module instance.
        persistSession: false,
        autoRefreshToken: true,
      },
    });
  }
  return client;
}

async function ensureSignedIn(): Promise<SupabaseClient> {
  const c = getClient();
  const {
    data: { session },
  } = await c.auth.getSession();
  if (session) return c;

  if (!signInPromise) {
    const email = process.env.SALES_USER_EMAIL;
    const password = process.env.SALES_USER_PASSWORD;
    if (!email || !password) throw new Error("SALES_USER_EMAIL / SALES_USER_PASSWORD are not set.");
    signInPromise = (async () => {
      const { data, error } = await c.auth.signInWithPassword({ email, password });
      console.error("[salesSource:signIn]", { hasSession: Boolean(data?.session), error });
      if (isRealError(error)) throw new SalesSourceError("sign_in", error);
    })().finally(() => {
      signInPromise = null;
    });
  }
  await signInPromise;
  return c;
}

export async function getSalesSourceClient(): Promise<SupabaseClient> {
  return ensureSignedIn();
}

// Supabase's PostgREST "Max Rows" project setting has, on this app's own
// project, silently capped every response at 1000 regardless of a bare
// .limit() (see lib/data/client.ts's fetchAllRows for the full story) — a
// second project may well have the same default. Pages defensively via
// .range() rather than assuming this one is configured differently.
export async function fetchAllSalesSourceRows<T>(
  // Deliberately `any`-typed — callers build a `.from().select()` chain
  // whose exact PostgrestFilterBuilder<...> generic varies per call
  // (supabase-js's own .range() return type isn't a plain Promise, it's
  // another thenable builder, which defeats a precise shared signature for
  // a single-purpose internal helper). The real safety net is `error`
  // being checked below, same as everywhere else this app talks to
  // PostgREST.
  buildQuery: (client: SupabaseClient) => any,
  pageSize = 1000
): Promise<T[]> {
  const c = await ensureSignedIn();
  const all: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error, status, statusText, count } = await buildQuery(c).range(from, from + pageSize - 1);
    console.error("[salesSource:fetchAllSalesSourceRows]", {
      from,
      to: from + pageSize - 1,
      status,
      statusText,
      count,
      dataLength: Array.isArray(data) ? data.length : data,
      error,
    });
    if (isRealError(error)) throw new SalesSourceError("query", error);
    const rows = (data ?? []) as T[];
    all.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return all;
}
