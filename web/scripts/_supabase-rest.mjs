/**
 * Shared Supabase auth + PostgREST access for the verification scripts.
 *
 * WHY THIS EXISTS: verify-query-planner.mjs, verify-filter-engine.mjs and
 * the now-deleted parity-check.mjs each carried their own copy of a Keycloak token fetch and
 * a hand-rolled PostgREST client. When this project migrated from Keycloak to
 * Supabase Auth (see lib/supabase/userAdmin.ts's header), all three broke at
 * once and stayed broken — they fail on
 *
 *     TypeError: Failed to parse URL from
 *       undefined/realms/undefined/protocol/openid-connect/token
 *
 * before reaching a single assertion. Objective.md still cites them as the
 * evidence for the planner and filter engine being correct, so that evidence
 * had quietly expired. One shared module means the next auth change breaks
 * (and gets fixed in) one place.
 *
 * WHY A REAL USER SESSION, NOT THE SERVICE-ROLE KEY: these harnesses exist
 * partly to prove RLS scoping actually applies. service_role bypasses RLS, so
 * using it would make every assertion pass for the wrong reason. They sign in
 * as a real, ordinary user exactly as the app does.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/**
 * Fixture account, documented in HANDOFF.md. A local seeded test user, not a
 * production credential. Overridable so the harness can be pointed at a
 * narrower account to prove a role sees less.
 */
export const FIXTURE_EMAIL = process.env.VERIFY_USER_EMAIL ?? "testadmin@retailbi.local";
export const FIXTURE_PASSWORD = process.env.VERIFY_USER_PASSWORD ?? "TestAdmin123!";

export function requireEnv() {
  const missing = [];
  if (!SUPABASE_URL) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!ANON_KEY) missing.push("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  if (missing.length > 0) {
    throw new Error(
      `Missing ${missing.join(", ")}.\nRun with: node --env-file=.env.local scripts/<script>.mjs`
    );
  }
}

/** Password grant against Supabase Auth — the REST equivalent of signInWithPassword. */
export async function getAccessToken(email = FIXTURE_EMAIL, password = FIXTURE_PASSWORD) {
  requireEnv();
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(
      `Supabase sign-in failed for ${email}: ${body.error_description ?? body.msg ?? JSON.stringify(body)}`
    );
  }
  return body.access_token;
}

const restUrl = () => `${SUPABASE_URL}/rest/v1`;

/**
 * Headers every PostgREST call needs. Supabase requires `apikey` IN ADDITION
 * to the bearer token — the standalone PostgREST these scripts used to talk to
 * did not, which is the other reason a straight URL swap wouldn't have worked.
 */
function headers(token, schema) {
  return {
    apikey: ANON_KEY,
    Authorization: `Bearer ${token}`,
    ...(schema ? { "Accept-Profile": schema } : {}),
  };
}

/** Raw query against a schema: restGet(token, "workspace", "metric_definitions?select=id"). */
export async function restGet(token, schema, query) {
  const res = await fetch(`${restUrl()}/${query}`, { headers: headers(token, schema) });
  const body = await res.json();
  if (!res.ok) throw new Error(`${schema}/${query} -> ${JSON.stringify(body)}`);
  return body;
}

/**
 * A minimal stand-in for lib/data/client.ts's DataClient, shaped so the REAL
 * exported functions of queryPlanner.ts can be handed it unmodified. The point
 * of these harnesses is to exercise the shipped code, not a reimplementation,
 * so this mimics only the surface buildQuery() actually touches.
 *
 * `_url` is exposed so a test can assert what reached the wire — the only way
 * to prove a filter was really pushed down rather than applied in JS after.
 */
export function restClient(token) {
  return {
    schema(schemaName) {
      return {
        from(table) {
          const params = new URLSearchParams();
          const chain = {
            select(cols) {
              params.set("select", cols);
              return chain;
            },
            gte(col, val) {
              params.append(col, `gte.${val}`);
              return chain;
            },
            lte(col, val) {
              params.append(col, `lte.${val}`);
              return chain;
            },
            eq(col, val) {
              params.append(col, `eq.${val}`);
              return chain;
            },
            in(col, vals) {
              params.append(col, `in.(${vals.join(",")})`);
              return chain;
            },
            order() {
              return chain;
            },
            limit(n) {
              params.set("limit", String(n));
              return chain;
            },
            get _url() {
              return `${restUrl()}/${table}?${params}`;
            },
            async _exec() {
              const res = await fetch(chain._url, { headers: headers(token, schemaName) });
              const data = await res.json();
              if (!res.ok) throw new Error(JSON.stringify(data));
              return { data, error: null, _url: chain._url };
            },
            then(resolve, reject) {
              return chain._exec().then(resolve, reject);
            },
          };
          return chain;
        },
      };
    },
  };
}

/** Shared PASS/FAIL reporting so every harness prints the same way. */
export function createReporter() {
  let failures = 0;
  return {
    ok(condition, message) {
      console.log(`${condition ? "PASS" : "FAIL"}  ${message}`);
      if (!condition) failures += 1;
    },
    summary(label) {
      console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`} — ${label}`);
      return failures === 0;
    },
  };
}
