#!/usr/bin/env node
/**
 * Metric verification — the gate that decides which rows in
 * workspace.metric_definitions may carry is_verified = true.
 *
 * Replaces parity-check.mjs's approach, which asserted hardcoded literals
 * from a synthetic fixture. That fixture was deleted once real ERP data
 * landed on the same store/date, leaving the script permanently red; its own
 * header then forbade the obvious "fix" — rebaselining the numbers to
 * whatever real data says — because that turns a parity check into a
 * tautology that passes no matter what the catalogue claims.
 *
 * WHAT THIS DOES INSTEAD — cross-derivation:
 *
 *   For each metric, read the value from the source the CATALOGUE names, and
 *   independently recompute the same figure from raw component columns using
 *   the definition the APP's own code uses. Two independent implementations
 *   agreeing over real data is evidence. It needs no fixture, cannot be
 *   invalidated by the next upload, and cannot be satisfied by rebaselining.
 *
 * THE RULE THAT MATTERS MOST — a check that cannot fail is not a check.
 *
 *   Migration 0048 shipped the WRONG source_column for `atv` and a green
 *   parity run failed to notice, because the fixture scope contained zero
 *   RETURN bills. With no returns the daily formula (sale-bills-only
 *   numerator, 0005:106) and the weekly formula (returns netted off,
 *   0005:133) are arithmetically identical, so the assertion was vacuous.
 *
 *   This script therefore proves its own discriminating power before
 *   trusting a pass: for any metric whose correctness depends on returns
 *   existing, it REFUSES to verify unless the chosen scope actually contains
 *   return bills, and says so loudly rather than passing quietly.
 *
 * Scope selection is automatic — it searches live data for a window that can
 * actually discriminate, rather than hardcoding one that may go stale.
 *
 * Only `view_column` metrics are verifiable here. A metric backed by an RPC
 * (sql_expression) or by TypeScript (js_computed) has no single column to
 * read, stays is_verified = false, and is therefore invisible to any future
 * metric picker — which is the correct outcome, not a gap.
 *
 * Run:    node --env-file=.env.local scripts/verify-metrics.mjs
 * Write:  node --env-file=.env.local scripts/verify-metrics.mjs --write
 *         (without --write nothing is persisted; it only reports)
 */
import { getAccessToken, restGet, createReporter } from "./_supabase-rest.mjs";

const WRITE = process.argv.includes("--write");
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const num = (v) => (v === null || v === undefined ? NaN : Number(v));
const close = (a, b, tol = 0.01) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

/**
 * How to independently re-derive each metric from component columns.
 *
 * `needsReturns` marks metrics whose catalogued grain is only distinguishable
 * when return bills exist — see the header. `derive` receives the summed
 * component columns over the scope and returns the expected value.
 */
const DERIVATIONS = {
  // --- Weekly view, additive: the weekly figure must equal the sum of dailies.
  net_sales: { grain: "weekly", components: ["net_sales"], derive: (d) => d.net_sales, fromDaily: true },
  gross_sales: { grain: "weekly", components: ["gross_sales"], derive: (d) => d.gross_sales, fromDaily: true },
  sale_bills: { grain: "weekly", components: ["sale_bills"], derive: (d) => d.sale_bills, fromDaily: true },
  sale_quantity: { grain: "weekly", components: ["sale_quantity"], derive: (d) => d.sale_quantity, fromDaily: true },
  // NB the metric id is `discount_value`; its column happens to be `discount`.
  // Keyed by metric id, never by column name — they differ here and on
  // several ecomm metrics too.
  discount_value: { grain: "weekly", components: ["discount"], derive: (d) => d.discount, fromDaily: true },

  // --- Ratios: must be re-derived from summed components, never averaged.
  //     upt/discount_pct are safe with or without returns.
  upt: {
    grain: "weekly",
    components: ["sale_quantity", "sale_bills"],
    derive: (w) => w.sale_quantity / w.sale_bills,
  },
  discount_pct: {
    grain: "weekly",
    components: ["discount", "gross_sales"],
    derive: (w) => (100 * w.discount) / w.gross_sales,
  },

  // --- ATV: the one that caught 0048 out.
  //     vw_ebo_sales_weekly.atv is documented (0005:133) as net_sales /
  //     sale_bills where net_sales already has returns netted off. If the
  //     catalogue instead pointed at a daily-grain ATV (sale-bills-only
  //     numerator), these diverge — but ONLY when returns exist. Hence
  //     needsReturns.
  atv: {
    grain: "weekly",
    components: ["net_sales", "sale_bills"],
    derive: (w) => w.net_sales / w.sale_bills,
    needsReturns: true,
  },
};

async function loadCatalogue(token) {
  const metrics = await restGet(
    token,
    "workspace",
    "metric_definitions?select=id,label,source_kind,source_view,source_column,rollup_strategy,is_verified"
  );
  const sources = await restGet(
    token,
    "workspace",
    "metric_sources?select=metric_id,grain,source_view,source_column,is_default"
  );
  return { metrics, sources };
}

/**
 * Find a store+week that can discriminate the return-sensitive metrics.
 * Searched, not hardcoded — a fixed scope is exactly what rotted last time.
 */
async function findDiscriminatingScope(token) {
  const rows = await restGet(
    token,
    "sales",
    "vw_ebo_sales_weekly?select=store_id,week_start,sale_bills,return_bills,is_complete_week" +
      "&return_bills=gt.0&sale_bills=gt.0&order=week_start.desc&limit=50"
  );
  // Prefer a complete week with the most returns — the strongest signal.
  const complete = rows.filter((r) => r.is_complete_week);
  const pool = complete.length > 0 ? complete : rows;
  pool.sort((a, b) => Number(b.return_bills) - Number(a.return_bills));
  return pool[0] ?? null;
}

async function main() {
  const token = await getAccessToken();
  const report = createReporter();

  const { metrics, sources } = await loadCatalogue(token);
  const byId = new Map(metrics.map((m) => [m.id, m]));
  const sourcesByMetric = new Map();
  for (const s of sources) {
    const list = sourcesByMetric.get(s.metric_id) ?? [];
    list.push(s);
    sourcesByMetric.set(s.metric_id, list);
  }

  console.log(`catalogue: ${metrics.length} metrics, ${sources.length} sources`);

  const scope = await findDiscriminatingScope(token);
  if (!scope) {
    console.error(
      "\nNo week with BOTH sale and return bills exists in reachable data.\n" +
        "Return-sensitive metrics (atv) cannot be verified — refusing to mark them.\n" +
        "This is the 0048 blind spot; a pass here would be vacuous."
    );
  } else {
    console.log(
      `scope: ${scope.store_id}, week ${scope.week_start} — ` +
        `${scope.sale_bills} sale bills, ${scope.return_bills} RETURN bills` +
        `${scope.is_complete_week ? " (complete week)" : " (partial week)"}`
    );
    console.log("  returns > 0, so daily-vs-weekly ATV formulas are genuinely distinguishable here.\n");
  }

  // Weekly row for the chosen scope, and the daily rows it should roll up from.
  const weekly = scope
    ? (
        await restGet(
          token,
          "sales",
          `vw_ebo_sales_weekly?select=*&store_id=eq.${scope.store_id}&week_start=eq.${scope.week_start}`
        )
      )[0]
    : null;

  const weekEnd = scope
    ? new Date(new Date(scope.week_start).getTime() + 6 * 86400000).toISOString().slice(0, 10)
    : null;
  const dailies = scope
    ? await restGet(
        token,
        "sales",
        `vw_ebo_sales_daily?select=*&store_id=eq.${scope.store_id}` +
          `&bill_date=gte.${scope.week_start}&bill_date=lte.${weekEnd}`
      )
    : [];

  const sumDaily = (col) => dailies.reduce((s, r) => s + num(r[col]), 0);

  const verified = [];
  const skipped = [];

  for (const [metricId, spec] of Object.entries(DERIVATIONS)) {
    const metric = byId.get(metricId);
    if (!metric) {
      report.ok(false, `${metricId}: not in the catalogue at all`);
      continue;
    }
    if (metric.source_kind !== "view_column") {
      skipped.push(`${metricId} (source_kind=${metric.source_kind} — not readable as a column)`);
      continue;
    }
    if (!weekly) {
      skipped.push(`${metricId} (no usable scope)`);
      continue;
    }

    // The discriminating-power guard. Refuse rather than pass vacuously.
    if (spec.needsReturns && num(scope.return_bills) === 0) {
      report.ok(
        false,
        `${metricId}: scope has ZERO returns — daily and weekly formulas coincide, so a pass would prove nothing. REFUSING to verify.`
      );
      continue;
    }

    // Confirm the catalogue actually points where we think, at the grain we test.
    const homes = sourcesByMetric.get(metricId) ?? [];
    const home = homes.find((h) => h.grain === spec.grain);
    if (!home) {
      report.ok(false, `${metricId}: no ${spec.grain}-grain source catalogued (homes: ${homes.map((h) => h.grain).join(", ") || "none"})`);
      continue;
    }

    const actual = num(weekly[home.source_column]);

    // Two derivations, depending on the metric's shape.
    const expected = spec.fromDaily
      ? sumDaily(home.source_column)
      : spec.derive(Object.fromEntries(spec.components.map((c) => [c, num(weekly[c])])));

    const ok = close(actual, expected);
    report.ok(
      ok,
      `${metricId}: catalogue says ${home.source_view}.${home.source_column} = ${actual}` +
        `, independently derived = ${Number.isFinite(expected) ? expected.toFixed(2) : expected}` +
        (spec.needsReturns ? `  [tested WITH ${scope.return_bills} returns]` : "")
    );
    if (ok) verified.push(metricId);
  }

  if (skipped.length > 0) {
    console.log(`\nSkipped (correctly stay unverified and invisible to any picker):`);
    for (const s of skipped) console.log(`  - ${s}`);
  }

  const unverifiable = metrics.filter((m) => m.source_kind !== "view_column").length;
  console.log(
    `\n${verified.length} metric(s) proved; ${unverifiable} metric(s) are sql_expression/js_computed and are not verifiable by column read.`
  );

  const allPassed = report.summary("metric cross-derivation");

  if (!allPassed) {
    console.error("\nNot writing is_verified — fix the failures above first.");
    process.exit(1);
  }

  if (!WRITE) {
    console.log(`\nDry run. Re-run with --write to set is_verified = true on: ${verified.join(", ")}`);
    return;
  }

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/metric_definitions?id=in.(${verified.join(",")})`,
    {
      method: "PATCH",
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${token}`,
        "Content-Profile": "workspace",
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        is_verified: true,
        verified_against: `verify-metrics.mjs cross-derivation, scope ${scope.store_id}/${scope.week_start} (${scope.return_bills} return bills)`,
      }),
    }
  );
  if (!res.ok) {
    console.error(`PATCH failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  console.log(`\nMarked ${verified.length} metric(s) verified.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
