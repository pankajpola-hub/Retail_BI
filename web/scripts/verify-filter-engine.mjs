#!/usr/bin/env node
/**
 * Phase 6 verification — the governed filter engine, exercised through the
 * REAL exported functions of lib/workspace/queryPlanner.ts against live
 * PostgREST data (same plain-Node convention as parity-check.mjs and
 * verify-query-planner.mjs; this project has no test framework).
 *
 * The assertion that matters most is #2. A filter engine that silently DROPS
 * a filter it cannot express is worse than one that refuses: the caller
 * renders unfiltered rows believing they are filtered, and nothing looks
 * wrong on screen. This asserts the planner fails closed.
 *
 * Run: node --env-file=.env.local scripts/verify-filter-engine.mjs
 *
 * Asserts:
 *   1. A dimension filter whose column exists on the queried view is APPLIED
 *      (reaches the URL) and actually narrows the result.
 *   2. A dimension filter catalogued against a DIFFERENT view is reported as
 *      unapplied, isSatisfiable() is false, and buildQuery() REFUSES to run —
 *      rather than silently returning unfiltered rows.
 *   3. Two requirements differing only by filter values do NOT merge.
 *   4. An empty value list is a no-op (no predicate emitted).
 */
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, "..", "lib", "workspace", "queryPlanner.ts");
const scratchPath = path.join(__dirname, "..", "lib", "workspace", "__scratch_filterEngine.ts");

const { SELFHOSTED_KEYCLOAK_URL: KC, SELFHOSTED_KEYCLOAK_REALM: REALM,
        SELFHOSTED_KEYCLOAK_CLIENT_ID: CID, SELFHOSTED_KEYCLOAK_CLIENT_SECRET: CSEC,
        SELFHOSTED_POSTGREST_URL: PGRST } = process.env;

const FROM = "2026-07-19", TO = "2026-08-15";

async function getToken() {
  const r = await fetch(`${KC}/realms/${REALM}/protocol/openid-connect/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: CID, client_secret: CSEC, username: "testadmin", password: "TestAdmin123!" }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_description ?? j.error);
  return j.access_token;
}

async function get(token, schema, q) {
  const r = await fetch(`${PGRST}/${q}`, { headers: { Authorization: `Bearer ${token}`, "Accept-Profile": schema } });
  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  return j;
}

function client(token) {
  return {
    schema(s) {
      return {
        from(t) {
          const p = new URLSearchParams();
          const c = {
            select(x) { p.set("select", x); return c; },
            gte(k, v) { p.append(k, `gte.${v}`); return c; },
            lte(k, v) { p.append(k, `lte.${v}`); return c; },
            eq(k, v) { p.append(k, `eq.${v}`); return c; },
            in(k, v) { p.append(k, `in.(${v.join(",")})`); return c; },
            order() { return c; },
            get _url() { return `${PGRST}/${t}?${p}`; },
            async _exec() {
              const r = await fetch(c._url, { headers: { Authorization: `Bearer ${token}`, "Accept-Profile": s } });
              const data = await r.json();
              if (!r.ok) throw new Error(JSON.stringify(data));
              return { data, error: null, _url: c._url };
            },
            then(f, j) { return c._exec().then(f, j); },
          };
          return c;
        },
      };
    },
  };
}

let pass = true;
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) pass = false; };

async function main() {
  writeFileSync(scratchPath, readFileSync(sourcePath, "utf8").replace(/^import "server-only";\n/m, ""));
  try {
    const P = await import(pathToFileURL(scratchPath).href);
    const { resolveRequirement, groupResolvedQueries, buildQuery, isSatisfiable } = P;
    const token = await getToken();
    const supabase = client(token);

    const mRows = await get(token, "workspace", "metric_definitions?select=id,source_kind,source_view,source_column");
    const metricsById = new Map(mRows.map((r) => [r.id, { id: r.id, sourceKind: r.source_kind, sourceView: r.source_view, sourceColumn: r.source_column }]));
    const dRows = await get(token, "workspace", "dimension_definitions?select=id,source_view,source_column");
    const dimensionsById = new Map(dRows.map((r) => [r.id, { id: r.id, sourceView: r.source_view, sourceColumn: r.source_column }]));

    console.log(`dimension catalogue: ${dRows.length} rows; scheme_group -> ${dimensionsById.get("scheme_group")?.sourceView}.${dimensionsById.get("scheme_group")?.sourceColumn}`);

    const period = { from: FROM, to: TO };
    const base = { componentId: "scheme_penetration", metricIds: ["scheme_quantity"], period, comparison: "none", extraColumns: ["scheme_group"] };

    // --- 1. Applicable filter is applied and narrows ---
    const unfiltered = groupResolvedQueries(resolveRequirement({ ...base, filters: { storeIds: [] } }, metricsById, dimensionsById))[0];
    const { data: allRows } = await buildQuery(supabase, unfiltered);
    const groupsPresent = [...new Set(allRows.map((r) => r.scheme_group))];
    console.log(`\nunfiltered scheme rows: ${allRows.length}, groups: ${JSON.stringify(groupsPresent)}`);

    const target = groupsPresent[0];
    const filtered = groupResolvedQueries(resolveRequirement(
      { ...base, filters: { storeIds: [], dimensions: [{ dimensionId: "scheme_group", values: [target] }] } },
      metricsById, dimensionsById))[0];

    ok(filtered.appliedPredicates.length === 1 && filtered.appliedPredicates[0].column === "scheme_group",
      `scheme_group resolved to a real column: ${JSON.stringify(filtered.appliedPredicates)}`);
    ok(filtered.unappliedDimensionIds.length === 0, "no unapplied dimensions for an on-view filter");
    ok(isSatisfiable(filtered), "isSatisfiable() true for an applicable filter");

    const res = await buildQuery(supabase, filtered);
    const url = decodeURIComponent(res._url);
    ok(url.includes("scheme_group=eq.") || url.includes("scheme_group=in."),
      `predicate reached the URL: ${url}`);
    ok(res.data.every((r) => r.scheme_group === target),
      `every returned row matches the filter (${res.data.length} row(s), all "${target}")`);

    // --- 2. Inapplicable filter refuses rather than silently dropping ---
    // 'gender' is catalogued against sales.vw_item_gender_options, not the
    // scheme view — it cannot be expressed here without a join.
    const bad = groupResolvedQueries(resolveRequirement(
      { ...base, filters: { storeIds: [], dimensions: [{ dimensionId: "gender", values: ["FEMALE"] }] } },
      metricsById, dimensionsById))[0];
    ok(bad.unappliedDimensionIds.includes("gender"), `off-view dimension reported unapplied: ${JSON.stringify(bad.unappliedDimensionIds)}`);
    ok(!isSatisfiable(bad), "isSatisfiable() false when a filter cannot be applied");
    let threw = false;
    try { await buildQuery(supabase, bad); } catch { threw = true; }
    ok(threw, "buildQuery() THREW rather than returning unfiltered rows");

    // --- 3. Different filter values must not merge ---
    const a = resolveRequirement({ ...base, componentId: "a", filters: { storeIds: [], dimensions: [{ dimensionId: "scheme_group", values: ["X"] }] } }, metricsById, dimensionsById);
    const b = resolveRequirement({ ...base, componentId: "b", filters: { storeIds: [], dimensions: [{ dimensionId: "scheme_group", values: ["Y"] }] } }, metricsById, dimensionsById);
    ok(groupResolvedQueries([...a, ...b]).length === 2, "requirements with different filter VALUES stay separate queries");

    const c1 = resolveRequirement({ ...base, componentId: "c1", filters: { storeIds: [], dimensions: [{ dimensionId: "scheme_group", values: ["X"] }] } }, metricsById, dimensionsById);
    const c2 = resolveRequirement({ ...base, componentId: "c2", filters: { storeIds: [], dimensions: [{ dimensionId: "scheme_group", values: ["X"] }] } }, metricsById, dimensionsById);
    ok(groupResolvedQueries([...c1, ...c2]).length === 1, "requirements with IDENTICAL filters still merge into one query");

    // --- 4. Empty value list is a no-op ---
    const empty = groupResolvedQueries(resolveRequirement(
      { ...base, filters: { storeIds: [], dimensions: [{ dimensionId: "scheme_group", values: [] }] } },
      metricsById, dimensionsById))[0];
    ok(empty.appliedPredicates.length === 0 && empty.unappliedDimensionIds.length === 0,
      "empty value list emits no predicate and is not an error");
    const emptyUrl = decodeURIComponent((await buildQuery(supabase, empty))._url);
    ok(!emptyUrl.includes("scheme_group=eq.") && !emptyUrl.includes("scheme_group=in."),
      "empty value list adds no predicate to the URL");

    console.log(pass ? "\nPHASE 6 FILTER ENGINE OK" : "\nPHASE 6 CHECKS FAILED");
    return pass ? 0 : 1;
  } finally {
    try { unlinkSync(scratchPath); } catch {}
  }
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
