#!/usr/bin/env node
/**
 * PARTIALLY RETIRED — 2026-08-15. This script shares the Phase 3 parity
 * fixture (BO-001/Undri, 10/08/2026), which was deleted once real ERP data
 * made it redundant — real bills now also land on that date/store, so the
 * hardcoded expected literals below (search "1400") will fail against real
 * data, correctly. The GROUPING/mechanics assertions (merge vs. no-merge,
 * select-list column presence, extraColumns union/dedup) remain genuinely
 * meaningful and still pass — only the literal-value assertions are stale.
 * See parity-check.mjs's header for the full explanation and how to restore
 * a working fixture if full coverage is needed again.
 *
 * Phase 4 verification — exercises the REAL exported functions from
 * lib/workspace/queryPlanner.ts (not a reimplementation) against live
 * PostgREST data, proving:
 *   1. Two component requirements sharing the same view/period/store filter
 *      collapse into ONE physical query, not two.
 *   2. A requirement with a DIFFERENT store filter does NOT get merged into
 *      that group.
 *   3. The grouped query's result correctly satisfies both original
 *      requirements' expected values (same fixture as the Phase 3 parity
 *      harness — no separate ground truth invented here).
 *   4. Every resolved query's select list ALWAYS carries the view's date and
 *      store column (deduped) even when neither was requested as a metric,
 *      and those columns really come back populated from PostgREST — the
 *      trend chart in lib/workspace/renderSalesComponents.tsx groups by
 *      bill_date/store_id and would silently render nothing otherwise.
 *   5. The production usage shape: one requirement, one metric, a DATE RANGE,
 *      and an EMPTY storeIds list ("All stores") plans to exactly one query
 *      that applies NO store predicate at all — RLS alone scopes the result.
 *   6. extraColumns (the non-metric columns a component needs in the row) reach
 *      the select list, stay deduped against the date/store/metric columns, and
 *      come back populated from PostgREST — checked on scheme_group against
 *      sales.vw_ebo_scheme_daily, the shape renderSalesComponents.tsx:143 uses.
 *   7. Two requirements identical except for extraColumns still merge into ONE
 *      query whose column list is the UNION of both. The grouping key ignores
 *      extraColumns on purpose (queryPlanner.ts:202); the union is what makes
 *      that safe, so it is asserted rather than assumed.
 *   8. Omitting extraColumns (or passing it as undefined) is byte-identical to
 *      the pre-extraColumns behaviour — no crash, no literal "undefined" in the
 *      select list, which would 400 at PostgREST.
 *
 * Check 6 needs the metric rows migration 0050 registers. If they are absent
 * the script says so explicitly and exits non-zero rather than reporting a
 * green run with a silent hole in it.
 *
 * queryPlanner.ts has exactly one runtime dependency that doesn't work
 * under plain Node: `import "server-only"`, a Next.js marker package that
 * unconditionally throws outside a webpack server build. Every other import
 * in that file is `import type` (erased entirely by TS). So: copy the
 * source to a scratch file with that one line removed, execute it with
 * Node's native TS support, then clean up — this runs the actual shipped
 * logic byte-for-byte (minus the one import line that only ever throws
 * outside Next anyway), not a parallel copy that could drift.
 *
 * Run: node --env-file=.env.local scripts/verify-query-planner.mjs
 */
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, "..", "lib", "workspace", "queryPlanner.ts");
const scratchPath = path.join(__dirname, "..", "lib", "workspace", "__scratch_queryPlanner.ts");

const POSTGREST_URL = process.env.SELFHOSTED_POSTGREST_URL;
const KEYCLOAK_URL = process.env.SELFHOSTED_KEYCLOAK_URL;
const REALM = process.env.SELFHOSTED_KEYCLOAK_REALM;
const CLIENT_ID = process.env.SELFHOSTED_KEYCLOAK_CLIENT_ID;
const CLIENT_SECRET = process.env.SELFHOSTED_KEYCLOAK_CLIENT_SECRET;

const FIXTURE_STORE = "BO-001";
const FIXTURE_DATE = "2026-08-10";
// Date RANGE for the production-shape check (the trend chart never asks for a
// single day) — ends on the fixture day so at least the fixture row is in it.
const FIXTURE_RANGE_FROM = "2026-08-01";
const FIXTURE_RANGE_TO = FIXTURE_DATE;
// Date/store columns for sales.vw_ebo_sales_daily, per queryPlanner.ts's
// VIEW_DATE_COLUMN / VIEW_STORE_COLUMN lookups.
const SALES_DAILY_DATE_COLUMN = "bill_date";
const SALES_DAILY_STORE_COLUMN = "store_id";

async function getToken() {
  const res = await fetch(`${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      username: "testadmin",
      password: "TestAdmin123!",
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Token request failed: ${json.error_description ?? json.error}`);
  return json.access_token;
}

/** Plain PostgREST GET, for the few lookups that aren't planner output. */
async function pgrstRaw(token, schema, path) {
  const res = await fetch(`${POSTGREST_URL}/${path}`, {
    headers: { Authorization: `Bearer ${token}`, "Accept-Profile": schema },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`PostgREST error on ${path}: ${JSON.stringify(json)}`);
  return json;
}

async function fetchMetricDefinitions(token) {
  const res = await fetch(
    `${POSTGREST_URL}/metric_definitions?select=id,source_kind,source_view,source_column`,
    { headers: { Authorization: `Bearer ${token}`, "Accept-Profile": "workspace" } }
  );
  const rows = await res.json();
  if (!res.ok) throw new Error(`Failed to load metric_definitions: ${JSON.stringify(rows)}`);
  return new Map(
    rows.map((r) => [
      r.id,
      { id: r.id, sourceKind: r.source_kind, sourceView: r.source_view, sourceColumn: r.source_column },
    ])
  );
}

// Minimal DataClient stand-in — real HTTP calls to the same PostgREST
// endpoint the app uses, just without the Next.js request-cookie plumbing
// (this script authenticates once with the fixture user instead).
function makeDataClient(token) {
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
            async _exec() {
              const url = `${POSTGREST_URL}/${table}?${params.toString()}`;
              const res = await fetch(url, {
                headers: { Authorization: `Bearer ${token}`, "Accept-Profile": schemaName },
              });
              const data = await res.json();
              if (!res.ok) throw new Error(`Query failed: ${JSON.stringify(data)}`);
              return { data, error: null, _url: url };
            },
            then(onFulfilled, onRejected) {
              return chain._exec().then(onFulfilled, onRejected);
            },
          };
          return chain;
        },
      };
    },
  };
}

async function main() {
  // Strip the one line that only ever throws outside a Next.js server build.
  const source = readFileSync(sourcePath, "utf8").replace(/^import "server-only";\n/m, "");
  writeFileSync(scratchPath, source);

  try {
    const planner = await import(pathToFileURL(scratchPath).href);
    const { resolveRequirement, groupResolvedQueries, buildQuery } = planner;

    const token = await getToken();
    const metricsById = await fetchMetricDefinitions(token);
    const supabase = makeDataClient(token);

    // Two DIFFERENT components both wanting sales_kpi-shaped metrics for the
    // exact same store/day — should collapse into ONE physical query.
    const reqA = {
      componentId: "sales_kpi_grid",
      metricIds: ["net_sales", "gross_sales", "sale_bills"],
      period: { from: FIXTURE_DATE, to: FIXTURE_DATE },
      comparison: "none",
      filters: { storeIds: [FIXTURE_STORE] },
    };
    // Metrics chosen so every one resolves to the DAILY view — this case
    // exists to test exact-match grouping, not grain resolution.
    //
    // This list used to be ["atv", "upt", "sale_quantity"]. Migration 0050
    // repointed atv/upt to sales.vw_ebo_sales_weekly, so that list now spans
    // two views and legitimately resolves to 2 queries, which made this
    // grouping assertion fail for a reason that had nothing to do with
    // grouping. The mixed-grain case is asserted separately as reqD below
    // rather than smuggled in here.
    const reqB = {
      componentId: "store_league_table",
      metricIds: ["sale_quantity", "discount_value"],
      period: { from: FIXTURE_DATE, to: FIXTURE_DATE },
      comparison: "none",
      filters: { storeIds: [FIXTURE_STORE] },
    };
    // A THIRD requirement, same view, but a DIFFERENT store filter — must
    // NOT merge with A/B.
    const reqC = {
      componentId: "store_league_table_other_store",
      metricIds: ["net_sales"],
      period: { from: FIXTURE_DATE, to: FIXTURE_DATE },
      comparison: "none",
      filters: { storeIds: ["BO-003"] },
    };

    const resolvedA = resolveRequirement(reqA, metricsById);
    const resolvedB = resolveRequirement(reqB, metricsById);
    const resolvedC = resolveRequirement(reqC, metricsById);
    console.log(`Resolved: A=${resolvedA.length} query(ies), B=${resolvedB.length}, C=${resolvedC.length} (3 requirements, 3 physical queries if UNgrouped)`);

    let pass = true;

    // ---------------------------------------------------------------------
    // Migration 0050's grain split, asserted directly: net_sales lives on the
    // DAILY view and atv now lives on the WEEKLY one, so a single requirement
    // naming both MUST resolve to two physical queries against two different
    // views — never silently collapse to one. Before 0050 both pointed at the
    // daily view and this would have produced a single query carrying an ATV
    // whose numerator excludes returns, which is not the ATV any page renders.
    // ---------------------------------------------------------------------
    const reqD = {
      componentId: "mixed_grain_probe",
      metricIds: ["net_sales", "atv"],
      period: { from: FIXTURE_DATE, to: FIXTURE_DATE },
      comparison: "none",
      filters: { storeIds: [FIXTURE_STORE] },
    };
    const resolvedD = groupResolvedQueries(resolveRequirement(reqD, metricsById));
    const viewsD = [...new Set(resolvedD.map((q) => q.sourceView))].sort();
    const expectedViewsD = ["sales.vw_ebo_sales_daily", "sales.vw_ebo_sales_weekly"];
    if (viewsD.length !== 2 || viewsD[0] !== expectedViewsD[0] || viewsD[1] !== expectedViewsD[1]) {
      console.error(`FAIL  mixed-grain requirement resolved to views [${viewsD.join(", ")}], expected [${expectedViewsD.join(", ")}] — is migration 0050 applied?`);
      pass = false;
    } else {
      console.log(`PASS  mixed-grain requirement split across both grains: [${viewsD.join(", ")}]`);
      const weekly = resolvedD.find((q) => q.sourceView === "sales.vw_ebo_sales_weekly");
      const okWeeklyCols = weekly.columns.includes("atv") && weekly.dateColumn === "week_start";
      console.log(`${okWeeklyCols ? "PASS" : "FAIL"}  weekly half selects atv filtered on week_start: columns=[${weekly.columns.join(", ")}], dateColumn=${weekly.dateColumn}`);
      if (!okWeeklyCols) pass = false;

      // Execute the weekly half over the week CONTAINING the fixture day. The
      // planner filters week_start by the requirement's period, and the
      // fixture day is mid-week, so querying it with from=to=FIXTURE_DATE
      // would correctly return nothing — widen to the week's own start.
      const weekStartRows = await pgrstRaw(
        token,
        "sales",
        `vw_ebo_sales_daily?select=week_start&store_id=eq.${FIXTURE_STORE}&bill_date=eq.${FIXTURE_DATE}`
      );
      const fixtureWeekStart = weekStartRows[0]?.week_start;
      if (!fixtureWeekStart) {
        console.error("FAIL  could not resolve the fixture day's week_start");
        pass = false;
      } else {
        const { data: weeklyData } = await buildQuery(supabase, {
          ...weekly,
          columns: [...new Set([...weekly.columns, "upt", "sale_bills", "net_sales", "sale_quantity"])],
          period: { from: fixtureWeekStart, to: fixtureWeekStart },
        });
        const w = weeklyData[0];
        if (!w) {
          console.error(`FAIL  weekly query returned no row for week_start=${fixtureWeekStart}`);
          pass = false;
        } else {
          // Weekly ATV = sum(net_sales)/sum(sale_bills) — returns NETTED off
          // (0005:133). On the fixture week this is the whole week's figures,
          // so assert the identity rather than a hardcoded constant.
          const expectedAtv = Number(w.net_sales) / Number(w.sale_bills);
          for (const [label, actual, expected] of [
            ["atv", w.atv, expectedAtv],
            ["upt", w.upt, Number(w.sale_quantity ?? 0) / Number(w.sale_bills)],
          ]) {
            if (expected === undefined || Number.isNaN(expected)) continue;
            const ok = Math.abs(Number(actual) - expected) <= 0.01;
            console.log(`${ok ? "PASS" : "FAIL"}  weekly query ${label} matches its re-derived definition: expected ${expected.toFixed(3)}, got ${actual}`);
            if (!ok) pass = false;
          }
        }
      }
    }

    const grouped = groupResolvedQueries([...resolvedA, ...resolvedB, ...resolvedC]);
    console.log(`Grouped into ${grouped.length} physical quer${grouped.length === 1 ? "y" : "ies"}.`);

    if (grouped.length !== 2) {
      console.error(`FAIL  expected 2 groups (A+B merged, C separate), got ${grouped.length}`);
      pass = false;
    } else {
      const mergedGroup = grouped.find((g) => g.servedRequirements.length === 2);
      const soloGroup = grouped.find((g) => g.servedRequirements.length === 1);
      if (!mergedGroup || !mergedGroup.servedRequirements.includes("sales_kpi_grid") || !mergedGroup.servedRequirements.includes("store_league_table")) {
        console.error("FAIL  A+B did not merge into one group serving both componentIds");
        pass = false;
      } else {
        console.log(`PASS  A+B merged into one query serving [${mergedGroup.servedRequirements.join(", ")}], columns=[${mergedGroup.columns.join(", ")}]`);
      }
      if (!soloGroup || soloGroup.servedRequirements[0] !== "store_league_table_other_store") {
        console.error("FAIL  C did not stay separate (different store filter)");
        pass = false;
      } else {
        console.log(`PASS  C stayed a separate query (different store filter) serving [${soloGroup.servedRequirements.join(", ")}]`);
      }

      // The select list must ALWAYS carry the view's date + store columns,
      // even though neither bill_date nor store_id is a metric anyone asked
      // for — renderSalesComponents.tsx groups the rows by both.
      if (mergedGroup) {
        const cols = mergedGroup.columns;
        for (const required of [SALES_DAILY_DATE_COLUMN, SALES_DAILY_STORE_COLUMN]) {
          const ok = cols.includes(required);
          console.log(`${ok ? "PASS" : "FAIL"}  merged group columns include unrequested ${required}: [${cols.join(", ")}]`);
          if (!ok) pass = false;
        }
        const dupes = cols.filter((c, i) => cols.indexOf(c) !== i);
        if (dupes.length) {
          console.error(`FAIL  merged group columns contain duplicates: [${dupes.join(", ")}]`);
          pass = false;
        } else {
          console.log(`PASS  merged group columns are deduped (${cols.length} unique)`);
        }
      }

      // Execute the merged group's ONE physical query and confirm it
      // correctly carries every column both A and B needed.
      if (mergedGroup) {
        const { data } = await buildQuery(supabase, mergedGroup);
        const row = data[0];
        if (!row) {
          console.error("FAIL  merged query returned no row for the fixture");
          pass = false;
        } else {
          // Proves the select list actually reached PostgREST — not just that
          // the in-memory columns array looked right.
          for (const required of [SALES_DAILY_DATE_COLUMN, SALES_DAILY_STORE_COLUMN]) {
            const value = row[required];
            const ok = value !== undefined && value !== null;
            console.log(`${ok ? "PASS" : "FAIL"}  merged query row carries ${required}: ${JSON.stringify(value)}`);
            if (!ok) pass = false;
          }
          // atv/upt are deliberately NOT checked here: post-0050 they live on
          // the weekly view, so they are not columns of this daily-grain
          // query. Asserting them here would only ever prove that reqB had
          // silently pulled in the wrong grain. They are checked against the
          // weekly query below instead.
          const checks = [
            ["net_sales", row.net_sales, 1400],
            ["gross_sales", row.gross_sales, 1500],
            ["sale_bills", row.sale_bills, 2],
            ["sale_quantity", row.sale_quantity, 3],
            ["discount", row.discount, 100],
          ];
          for (const [label, actual, expected] of checks) {
            const ok = Math.abs(Number(actual) - expected) <= 0.01;
            console.log(`${ok ? "PASS" : "FAIL"}  merged query column ${label}: expected ${expected}, got ${actual}`);
            if (!ok) pass = false;
          }
        }
      }
    }

    // ---------------------------------------------------------------------
    // Production usage shape: the SalesTrendChart's actual requirement — one
    // metric, a date range, and an EMPTY storeIds list, which is what an
    // "All stores" workspace passes. Correct behavior there is NO store
    // predicate at all, letting RLS alone scope the rows; asserting a row
    // count would be asserting the test user's grants, so we don't.
    // ---------------------------------------------------------------------
    const reqTrend = {
      componentId: "sales_trend_chart",
      metricIds: ["net_sales"],
      period: { from: FIXTURE_RANGE_FROM, to: FIXTURE_RANGE_TO },
      comparison: "none",
      filters: { storeIds: [] },
    };
    const trendPlanned = groupResolvedQueries(resolveRequirement(reqTrend, metricsById));
    if (trendPlanned.length !== 1) {
      console.error(`FAIL  trend requirement (all stores, date range) planned to ${trendPlanned.length} queries, expected 1`);
      pass = false;
    } else {
      const trend = trendPlanned[0];
      console.log(`PASS  trend requirement planned to exactly 1 query, columns=[${trend.columns.join(", ")}]`);

      const { data: trendData, _url } = await buildQuery(supabase, trend);
      const decodedUrl = decodeURIComponent(_url);
      const hasStorePredicate =
        decodedUrl.includes(`${SALES_DAILY_STORE_COLUMN}=eq.`) || decodedUrl.includes(`${SALES_DAILY_STORE_COLUMN}=in.`);
      if (hasStorePredicate) {
        console.error(`FAIL  empty storeIds still produced a store predicate: ${decodedUrl}`);
        pass = false;
      } else {
        console.log(`PASS  empty storeIds applied NO store filter (neither .eq nor .in): ${decodedUrl}`);
      }

      if (!Array.isArray(trendData) || trendData.length === 0) {
        console.error("FAIL  trend query returned no rows over the fixture date range");
        pass = false;
      } else {
        const missingDate = trendData.filter((r) => r[SALES_DAILY_DATE_COLUMN] == null);
        if (missingDate.length) {
          console.error(`FAIL  ${missingDate.length}/${trendData.length} trend rows have a null ${SALES_DAILY_DATE_COLUMN}`);
          pass = false;
        } else {
          console.log(`PASS  trend query returned ${trendData.length} row(s), every row has a non-null ${SALES_DAILY_DATE_COLUMN}`);
        }
      }
    }

    // ---------------------------------------------------------------------
    // extraColumns — non-metric columns a component needs in the row
    // (scheme_group to group by, bill_hour to bucket by). resolveRequirement
    // folds them into the same de-duplicating Set as the date/store/metric
    // columns, so they must appear exactly once and must survive to
    // PostgREST. Call sites: renderSalesComponents.tsx:143 (scheme_group),
    // :152 (bill_hour).
    // ---------------------------------------------------------------------
    const SCHEME_VIEW = "sales.vw_ebo_scheme_daily";
    const SCHEME_DATE_COLUMN = "bill_date"; // per queryPlanner.ts VIEW_DATE_COLUMN
    let prerequisiteMissing = false;

    const schemeMetric = metricsById.get("scheme_quantity");
    if (!schemeMetric || schemeMetric.sourceView !== SCHEME_VIEW || schemeMetric.sourceKind !== "view_column") {
      prerequisiteMissing = true;
      console.error(
        "\n==============================================================================\n" +
          "  PREREQUISITE MISSING — migration 0050 not applied?\n" +
          "==============================================================================\n" +
          `  workspace.metric_definitions has no plannable 'scheme_quantity' row on ${SCHEME_VIEW}\n` +
          `  (found: ${schemeMetric ? JSON.stringify(schemeMetric) : "no row at all"}).\n` +
          "  server/db/migrations/0050_semantic_layer_grain_corrections.sql registers it.\n" +
          "  The extraColumns-against-the-scheme-view check CANNOT run without it, so this\n" +
          "  run is reported as failed rather than green-with-a-hole. Apply 0050 (and let\n" +
          "  PostgREST reload its schema cache) and re-run.\n" +
          "=============================================================================="
      );
    } else {
      // Duplicates deliberately included: 'scheme_group' twice, plus the view's
      // own date column, so the de-dup path is genuinely exercised rather than
      // assumed from a list that had nothing to collapse.
      const reqScheme = {
        componentId: "scheme_penetration",
        metricIds: ["scheme_quantity"],
        period: { from: FIXTURE_RANGE_FROM, to: FIXTURE_RANGE_TO },
        comparison: "none",
        filters: { storeIds: [FIXTURE_STORE] },
        extraColumns: ["scheme_group", "scheme_group", SCHEME_DATE_COLUMN],
      };
      const schemePlanned = groupResolvedQueries(resolveRequirement(reqScheme, metricsById));
      if (schemePlanned.length !== 1) {
        console.error(`FAIL  scheme requirement planned to ${schemePlanned.length} queries, expected 1`);
        pass = false;
      } else {
        const sq = schemePlanned[0];
        const cols = sq.columns;
        const hasExtra = cols.includes("scheme_group");
        console.log(`${hasExtra ? "PASS" : "FAIL"}  extraColumns reached the select list: [${cols.join(", ")}]`);
        if (!hasExtra) pass = false;

        const dupes = cols.filter((c, i) => cols.indexOf(c) !== i);
        if (dupes.length) {
          console.error(`FAIL  extraColumns select list contains duplicates: [${dupes.join(", ")}]`);
          pass = false;
        } else {
          console.log(`PASS  extraColumns select list still deduped (${cols.length} unique, despite 2x scheme_group + a repeated ${SCHEME_DATE_COLUMN})`);
        }

        // In-memory column list looking right proves nothing until the query
        // runs — the whole point is that the component receives the column.
        const { data: schemeData } = await buildQuery(supabase, sq);
        if (!Array.isArray(schemeData) || schemeData.length === 0) {
          console.error("FAIL  scheme query returned no rows over the fixture range");
          pass = false;
        } else {
          const missingGroup = schemeData.filter((r) => r.scheme_group == null);
          if (missingGroup.length) {
            console.error(`FAIL  ${missingGroup.length}/${schemeData.length} scheme rows have a null scheme_group`);
            pass = false;
          } else {
            console.log(
              `PASS  scheme query returned ${schemeData.length} row(s), every row carries a non-null scheme_group (e.g. ${JSON.stringify(schemeData[0].scheme_group)})`
            );
          }
        }
      }
    }

    // Two requirements identical on (view, period, filters) but with DIFFERENT
    // extraColumns. The grouping key (queryPlanner.ts:202) deliberately does
    // NOT include extraColumns, so they still merge — and the merged column
    // list must be the UNION, because the one physical query has to satisfy
    // both consumers. Asserted rather than assumed: if grouping ever started
    // dropping the second requirement's extras, both components would still
    // "work" in the planner's own output shape and only break at render.
    const extrasPeriod = { from: FIXTURE_RANGE_FROM, to: FIXTURE_RANGE_TO };
    const reqExtraA = {
      componentId: "week_labelled_trend",
      metricIds: ["net_sales"],
      period: extrasPeriod,
      comparison: "none",
      filters: { storeIds: [FIXTURE_STORE] },
      extraColumns: ["retail_week"], // a real column of vw_ebo_sales_daily (0005:97)
    };
    const reqExtraB = {
      componentId: "weekday_breakdown",
      metricIds: ["net_sales"],
      period: extrasPeriod,
      comparison: "none",
      filters: { storeIds: [FIXTURE_STORE] },
      extraColumns: ["day_name"], // likewise 0005:97
    };
    const extrasGrouped = groupResolvedQueries([
      ...resolveRequirement(reqExtraA, metricsById),
      ...resolveRequirement(reqExtraB, metricsById),
    ]);
    if (extrasGrouped.length !== 1) {
      console.error(
        `FAIL  two requirements differing ONLY in extraColumns produced ${extrasGrouped.length} queries, expected 1 (grouping key must ignore extraColumns)`
      );
      pass = false;
    } else {
      const merged = extrasGrouped[0];
      const hasBoth = merged.columns.includes("retail_week") && merged.columns.includes("day_name");
      console.log(
        `${hasBoth ? "PASS" : "FAIL"}  differing extraColumns merged into ONE query with the UNION of both: [${merged.columns.join(", ")}]`
      );
      if (!hasBoth) pass = false;

      const servesBoth =
        merged.servedRequirements.includes("week_labelled_trend") && merged.servedRequirements.includes("weekday_breakdown");
      console.log(`${servesBoth ? "PASS" : "FAIL"}  merged extraColumns query serves both requirements: [${merged.servedRequirements.join(", ")}]`);
      if (!servesBoth) pass = false;

      const mdupes = merged.columns.filter((c, i) => merged.columns.indexOf(c) !== i);
      if (mdupes.length) {
        console.error(`FAIL  union of extraColumns introduced duplicates: [${mdupes.join(", ")}]`);
        pass = false;
      } else {
        console.log("PASS  union of extraColumns is still duplicate-free");
      }

      // The union must actually be selectable — a column name that survives
      // grouping but 400s at PostgREST is not a passing result.
      const { data: unionData } = await buildQuery(supabase, merged);
      if (!Array.isArray(unionData) || unionData.length === 0) {
        console.error("FAIL  merged extraColumns query returned no rows");
        pass = false;
      } else {
        const bad = unionData.filter((r) => r.retail_week == null || r.day_name == null);
        if (bad.length) {
          console.error(`FAIL  ${bad.length}/${unionData.length} rows missing retail_week or day_name`);
          pass = false;
        } else {
          console.log(`PASS  merged extraColumns query returned ${unionData.length} row(s) carrying BOTH extras`);
        }
      }
    }

    // extraColumns absent entirely (the shape every pre-Phase-5 caller uses)
    // must behave exactly as before: `...(requirement.extraColumns ?? [])`
    // spreads nothing — no crash, and critically no literal `undefined`
    // smuggled into the select list, which would produce `select=...,undefined`
    // and a PostgREST 400 at runtime.
    const reqNoExtras = {
      componentId: "no_extras_baseline",
      metricIds: ["net_sales"],
      period: extrasPeriod,
      comparison: "none",
      filters: { storeIds: [FIXTURE_STORE] },
    };
    const reqUndefinedExtras = { ...reqNoExtras, componentId: "explicit_undefined_extras", extraColumns: undefined };
    const baseline = resolveRequirement(reqNoExtras, metricsById);
    const explicitUndefined = resolveRequirement(reqUndefinedExtras, metricsById);
    if (baseline.length !== 1 || explicitUndefined.length !== 1) {
      console.error(`FAIL  no-extras requirements resolved to ${baseline.length}/${explicitUndefined.length} queries, expected 1 each`);
      pass = false;
    } else {
      const bcols = baseline[0].columns;
      const ucols = explicitUndefined[0].columns;
      const clean = [...bcols, ...ucols].every((c) => typeof c === "string" && c.length > 0 && c !== "undefined");
      console.log(`${clean ? "PASS" : "FAIL"}  omitted/undefined extraColumns produced no stray undefined: [${bcols.join(", ")}]`);
      if (!clean) pass = false;

      const same = bcols.length === ucols.length && bcols.every((c, i) => c === ucols[i]);
      console.log(`${same ? "PASS" : "FAIL"}  extraColumns: undefined is identical to omitting it: [${ucols.join(", ")}]`);
      if (!same) pass = false;

      // And unchanged from the pre-extraColumns contract: date + store + metric.
      const expected = [SALES_DAILY_DATE_COLUMN, SALES_DAILY_STORE_COLUMN, "net_sales"];
      const asExpected = expected.every((c) => bcols.includes(c)) && bcols.length === expected.length;
      console.log(`${asExpected ? "PASS" : "FAIL"}  no-extras select list unchanged from before extraColumns existed: [${bcols.join(", ")}]`);
      if (!asExpected) pass = false;

      const { data: baseData } = await buildQuery(supabase, baseline[0]);
      if (!Array.isArray(baseData) || baseData.length === 0) {
        console.error("FAIL  no-extras query returned no rows (a stray undefined column would 400 here)");
        pass = false;
      } else {
        console.log(`PASS  no-extras query executed cleanly, ${baseData.length} row(s)`);
      }
    }

    if (prerequisiteMissing) {
      console.error(
        "\nQuery planner verification INCOMPLETE — migration 0050 is not applied, so the scheme-view\nextraColumns check could not run. Exiting non-zero so this is not mistaken for a clean pass."
      );
      return 1;
    }
    if (!pass) {
      console.error("\nQuery planner verification FAILED.");
      return 1;
    }
    console.log(
      "\nAll query planner checks passed: grouping is correct, exact-match-only boundary respected, merged query data is correct, date/store columns are always selected and returned, an empty store filter narrows nothing, and extraColumns are carried through, deduped, unioned across merged requirements, and inert when absent."
    );
    return 0;
    // NOTE: failures RETURN an exit code rather than calling process.exit()
    // inside the try — process.exit() skips pending finally blocks, which
    // would leave __scratch_queryPlanner.ts sitting in lib/workspace/ after
    // every failed run and break the next tsc --noEmit.
  } finally {
    unlinkSync(scratchPath);
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    const code = err?.cause?.code ?? err?.code;
    if (code === "ECONNREFUSED" || code === "ENOTFOUND") {
      console.error(
        `\nCannot reach the local stack (${code}).\n` +
          `  Keycloak:  ${KEYCLOAK_URL}\n` +
          `  PostgREST: ${POSTGREST_URL}\n` +
          "  Start the local dev stack and re-run. Nothing was verified."
      );
      process.exit(1);
    }
    console.error(err);
    if (typeof err?.message === "string" && /does not exist|PGRST20[0-9]|scheme_group|metric_definitions/i.test(err.message)) {
      console.error(
        "\nA view, column, or catalogue row referenced above is missing — migration 0050 not applied? " +
          "Apply server/db/migrations/0050_semantic_layer_grain_corrections.sql and let PostgREST reload its schema cache."
      );
    }
    process.exit(1);
  });
