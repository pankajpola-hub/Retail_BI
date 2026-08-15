import "server-only";
import { postgrestConfig } from "@/lib/keycloak/config";
import { decodeJwt } from "@/lib/keycloak/session";

export type PostgrestError = { code: string; message: string; details: string | null; hint: string | null };
export type PostgrestResult<T> = { data: T | null; error: PostgrestError | null };

function encodeValue(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

/**
 * Chainable query builder over PostgREST's URL query-param filter syntax
 * (col=eq.value, col=gte.value, etc — see
 * https://postgrest.org/en/stable/references/api/tables_views.html#operators).
 * Deliberately mirrors supabase-js's PostgrestFilterBuilder method names
 * (.eq/.gte/.lte/.in/.order/.limit/.single/.maybeSingle) so page code
 * migrating off supabase-js later is a near-mechanical find/replace on the
 * client constructor, not a rewrite of every query. Only implements the
 * methods actually used in this codebase — grep for the method name before
 * assuming a supabase-js method "just works" here.
 */
class QueryBuilder<T = unknown> implements PromiseLike<PostgrestResult<T>> {
  private params = new URLSearchParams();
  private singleMode: "single" | "maybeSingle" | null = null;
  private method: "GET" | "POST" | "PATCH" | "DELETE" = "GET";
  private body: unknown = undefined;
  private preferParts: string[] = [];

  constructor(
    private baseUrl: string,
    private schema: string,
    private table: string,
    private accessToken: string | null
  ) {}

  select(cols = "*") {
    this.params.set("select", cols);
    return this;
  }
  eq(col: string, val: unknown) {
    this.params.append(col, `eq.${encodeValue(val)}`);
    return this;
  }
  neq(col: string, val: unknown) {
    this.params.append(col, `neq.${encodeValue(val)}`);
    return this;
  }
  gt(col: string, val: unknown) {
    this.params.append(col, `gt.${encodeValue(val)}`);
    return this;
  }
  gte(col: string, val: unknown) {
    this.params.append(col, `gte.${encodeValue(val)}`);
    return this;
  }
  lt(col: string, val: unknown) {
    this.params.append(col, `lt.${encodeValue(val)}`);
    return this;
  }
  lte(col: string, val: unknown) {
    this.params.append(col, `lte.${encodeValue(val)}`);
    return this;
  }
  in(col: string, vals: unknown[]) {
    this.params.append(col, `in.(${vals.map(encodeValue).join(",")})`);
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    const existing = this.params.get("order");
    const clause = `${col}.${opts?.ascending === false ? "desc" : "asc"}`;
    this.params.set("order", existing ? `${existing},${clause}` : clause);
    return this;
  }
  limit(n: number) {
    this.params.set("limit", String(n));
    return this;
  }
  single() {
    this.singleMode = "single";
    return this;
  }
  maybeSingle() {
    this.singleMode = "maybeSingle";
    return this;
  }
  insert(row: Record<string, unknown> | Record<string, unknown>[]) {
    this.method = "POST";
    this.body = row;
    this.preferParts.push("return=representation");
    return this;
  }
  upsert(row: Record<string, unknown> | Record<string, unknown>[], opts?: { onConflict?: string }) {
    this.method = "POST";
    this.body = row;
    this.preferParts.push("resolution=merge-duplicates", "return=representation");
    if (opts?.onConflict) this.params.set("on_conflict", opts.onConflict);
    return this;
  }
  update(row: Record<string, unknown>) {
    this.method = "PATCH";
    this.body = row;
    this.preferParts.push("return=representation");
    return this;
  }
  delete() {
    this.method = "DELETE";
    return this;
  }

  private async execute(): Promise<PostgrestResult<T>> {
    const url = `${this.baseUrl}/${this.table}${this.params.toString() ? `?${this.params}` : ""}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept-Profile": this.schema,
      "Content-Profile": this.schema,
    };
    if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;
    if (this.singleMode === "single") headers.Accept = "application/vnd.pgrst.object+json";
    if (this.preferParts.length > 0) headers.Prefer = this.preferParts.join(",");

    const res = await fetch(url, {
      method: this.method,
      headers,
      body: this.body !== undefined ? JSON.stringify(this.body) : undefined,
      cache: "no-store",
    });

    if (res.status === 204) return { data: null, error: null };

    const body = await res.json().catch(() => null);

    if (!res.ok) {
      return { data: null, error: body ?? { code: String(res.status), message: res.statusText, details: null, hint: null } };
    }

    if (this.singleMode === "maybeSingle" && Array.isArray(body)) {
      return { data: (body[0] ?? null) as T, error: null };
    }
    return { data: body as T, error: null };
  }

  then<TResult1 = PostgrestResult<T>, TResult2 = never>(
    onfulfilled?: ((value: PostgrestResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

class SchemaBuilder {
  constructor(private baseUrl: string, private schema: string, private accessToken: string | null) {}

  from<T = unknown>(table: string) {
    return new QueryBuilder<T>(this.baseUrl, this.schema, table, this.accessToken);
  }

  async rpc<T = unknown>(fnName: string, args: Record<string, unknown> = {}): Promise<PostgrestResult<T>> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Profile": this.schema,
    };
    if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;

    const res = await fetch(`${this.baseUrl}/rpc/${fnName}`, {
      method: "POST",
      headers,
      body: JSON.stringify(args),
      cache: "no-store",
    });
    if (res.status === 204) return { data: null, error: null };
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      return { data: null, error: body ?? { code: String(res.status), message: res.statusText, details: null, hint: null } };
    }
    return { data: body as T, error: null };
  }
}

/**
 * PostgREST-backed replacement for lib/supabase/server.ts's createClient().
 * Pass the caller's decoded access token (or null for an anonymous request)
 * — every query runs as that Postgres role, RLS-scoped exactly like the
 * Supabase original.
 */
export function createPostgrestClient(accessToken: string | null) {
  return {
    schema(name: string) {
      return new SchemaBuilder(postgrestConfig.baseUrl, name, accessToken);
    },
    auth: {
      async getUser() {
        if (!accessToken) return { data: { user: null } };
        try {
          const claims = decodeJwt(accessToken);
          return {
            data: {
              user: {
                id: claims.sub,
                email: claims.email ?? claims.preferred_username ?? null,
              },
            },
          };
        } catch {
          return { data: { user: null } };
        }
      },
    },
  };
}
