#!/usr/bin/env node
/**
 * RETIRED — 2026-08-15. The synthetic fixture this script hardcodes
 * (BO-001/Undri, 10/08/2026, 2 sale bills gross 1500/net 1400, footfall 20)
 * was deleted from the DB once real ERP data made it redundant per the
 * user's explicit direction, and real bills now also land on that exact
 * date/store — so this script's hardcoded expected values (line ~107+
 * below) no longer describe an isolated scope and WILL fail, correctly,
 * against whatever real data happens to be there. Do not "fix" the numbers
 * to match real data — real data changes on every upload, which would make
 * this a tautology, not a parity check. The GRAIN/structural checks further
 * down (ATV daily-vs-weekly, weekly rollup reconciliation, scheme/hourly
 * consistency) remain genuinely meaningful — they assert internal
 * consistency, not fixture literals — and can still be read for signal.
 * To restore full parity coverage: seed a new fixture at a store/date
 * combination confirmed to have zero real rows, independently confirm its
 * expected values against a live page render, and update FIXTURE_STORE/
 * FIXTURE_DATE and the literals in the `results` block below to match.
 *
 * Phase 3 parity harness — the exit gate the roadmap requires before any
 * semantic-layer metric can be marked is_verified. Queries each metric's
 * SQL source directly (same PostgREST endpoint the app uses, real JWT, real
 * RLS) against a fixed, known scope, and asserts the result against values
 * that were independently confirmed against the LIVE Network page in a
 * browser during this session (see conversation record — synthetic fixture,
 * REMOVED 2026-08-15, see header note above).
 *
 * This project has no test framework (see HANDOFF.md — verification today
 * is tsc --noEmit + manual browser + logs); this script follows that same
 * plain-Node convention rather than introducing Jest/Vitest for one harness.
 *
 * Run: node --env-file=.env.local scripts/parity-check.mjs
 * On success, marks the checked metrics workspace.metric_definitions.is_verified = true —
 * EXCEPT 'atv', which is withheld unless the fixture scope actually contains a
 * RETURN bill. See migration 0050's header: with zero returns the daily and
 * weekly ATV formulas coincide, so a green run there is not evidence about
 * which grain the catalogue should name. That blind spot is what let 0048
 * ship the wrong source_column, and this script must not re-create it.
 */

const KEYCLOAK_URL = process.env.SELFHOSTED_KEYCLOAK_URL;
const REALM = process.env.SELFHOSTED_KEYCLOAK_REALM;
const CLIENT_ID = process.env.SELFHOSTED_KEYCLOAK_CLIENT_ID;
const CLIENT_SECRET = process.env.SELFHOSTED_KEYCLOAK_CLIENT_SECRET;
const POSTGREST_URL = process.env.SELFHOSTED_POSTGREST_URL;

// Fixture credentials — the local-only test user created for this session,
// not a real account. See MEMORY/conversation record.
const FIXTURE_USER = "testadmin";
const FIXTURE_PASSWORD = "TestAdmin123!";
const FIXTURE_STORE = "BO-001";
const FIXTURE_DATE = "2026-08-10";

async function getToken() {
  const res = await fetch(`${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      username: FIXTURE_USER,
      password: FIXTURE_PASSWORD,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Token request failed: ${json.error_description ?? json.error}`);
  return json.access_token;
}

async function pgrst(token, schema, path) {
  const res = await fetch(`${POSTGREST_URL}/${path}`, {
    headers: { Authorization: `Bearer ${token}`, "Accept-Profile": schema },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`PostgREST error on ${path}: ${JSON.stringify(json)}`);
  return json;
}

function assertClose(label, actual, expected, tolerance = 0.01) {
  const a = Number(actual);
  const ok = Math.abs(a - expected) <= tolerance;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: expected ${expected}, got ${a}`);
  return ok;
}

function assertTrue(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

/** PostgREST hands numerics back as strings; nulls mean "no bills", which sums as 0. */
const num = (v) => (v === null || v === undefined ? 0 : Number(v));
/** Mirrors the views' own round(..., 2) so a comparison is like-for-like. */
const round2 = (n) => Math.round(n * 100) / 100;

/** Loud, unmissable block — used for statements a green run must NOT be read as disproving. */
function banner(title, lines) {
  const bar = "=".repeat(78);
  console.log(`\n${bar}\n  ${title}\n${bar}`);
  for (const l of lines) console.log(`  ${l}`);
  console.log(`${bar}\n`);
}

async function main() {
  if (!KEYCLOAK_URL || !POSTGREST_URL) {
    console.error("Missing env vars — run with: node --env-file=.env.local scripts/parity-check.mjs");
    process.exit(1);
  }

  const token = await getToken();

  // --- sales.vw_ebo_sales_daily, single day, single store ---
  const daily = await pgrst(
    token,
    "sales",
    `vw_ebo_sales_daily?select=*&store_id=eq.${FIXTURE_STORE}&bill_date=eq.${FIXTURE_DATE}`
  );
  const d = daily[0];
  if (!d) throw new Error("No vw_ebo_sales_daily row found for fixture — has the synthetic data been seeded?");

  const results = [];
  results.push(["net_sales", assertClose("net_sales", d.net_sales, 1400)]);
  results.push(["gross_sales", assertClose("gross_sales", d.gross_sales, 1500)]);
  results.push(["discount_value", assertClose("discount", d.discount, 100)]);
  results.push(["sale_bills", assertClose("sale_bills", d.sale_bills, 2)]);
  results.push(["sale_quantity", assertClose("sale_quantity", d.sale_quantity, 3)]);
  results.push(["atv", assertClose("atv", d.atv, 700)]);
  results.push(["upt", assertClose("upt", d.upt, 1.5)]);
  results.push(["discount_pct", assertClose("discount_pct", d.discount_pct, 6.67, 0.02)]);

  // --- ops.vw_ebo_conversion_daily, same day/store ---
  const conv = await pgrst(
    token,
    "ops",
    `vw_ebo_conversion_daily?select=*&store_id=eq.${FIXTURE_STORE}&bill_date=eq.${FIXTURE_DATE}`
  );
  const c = conv[0];
  if (!c) throw new Error("No vw_ebo_conversion_daily row found for fixture.");
  results.push(["conversion_pct", assertClose("conversion_pct", c.conversion_pct, 10)]);
  results.push(["sales_per_footfall", assertClose("sales_per_footfall", c.sales_per_footfall, 70)]);

  // =========================================================================
  // GRAIN CHECKS (added alongside migration 0050).
  //
  // `results` above holds metrics whose value was confirmed against a LIVE
  // PAGE render — those are the only ones eligible to be flipped to
  // is_verified. Everything below is a STRUCTURAL / internal-consistency
  // assertion: it proves the catalogue points at the column production
  // actually uses, or that two views reconcile. That is a different, weaker
  // claim than page parity, so these land in `structural` and never grant
  // is_verified to anything.
  // =========================================================================
  const structural = [];

  // --- Catalogue presence probe -------------------------------------------
  // 0050 repoints atv/upt/discount_pct and registers 4 new ids. If it has not
  // been applied, say so plainly here rather than letting a later step fail
  // with something cryptic.
  let defById = new Map();
  try {
    const defs = await pgrst(token, "workspace", "metric_definitions?select=id,source_view,source_column,is_verified");
    defById = new Map(defs.map((r) => [r.id, r]));
  } catch (err) {
    console.warn(`WARN  could not read workspace.metric_definitions (${err.message}) — catalogue assertions skipped.`);
  }
  const MIGRATION_0050_IDS = ["atv_sale_bills_only", "scheme_quantity", "scheme_net_sales", "hourly_net_sales"];
  const missing0050 = MIGRATION_0050_IDS.filter((id) => defById.size > 0 && !defById.has(id));
  const atvDef = defById.get("atv");
  const atvRepointed = atvDef?.source_view === "sales.vw_ebo_sales_weekly";
  if (defById.size > 0 && (missing0050.length > 0 || !atvRepointed)) {
    banner("MIGRATION 0050 DOES NOT APPEAR TO BE APPLIED", [
      missing0050.length ? `Missing metric_definitions rows: ${missing0050.join(", ")}` : "All new metric ids present.",
      atvDef
        ? `atv.source_view = ${atvDef.source_view} (0050 expects sales.vw_ebo_sales_weekly)`
        : "metric 'atv' has no row at all — is migration 0048 applied?",
      "The VIEW-level assertions below still run and are still meaningful (they read",
      "SQL views, not the catalogue), but the catalogue-vs-production agreement",
      "cannot be confirmed until 0050 is applied. Apply it and re-run.",
    ]);
  }

  // --- Fixture scope: the retail week containing the fixture day ------------
  // ATV differs between grains only across a scope that can contain a RETURN
  // bill, so the comparison is done over the whole retail week, not one day.
  const weekStart = d.week_start;
  if (!weekStart) throw new Error("Fixture daily row has no week_start — cannot locate the retail week.");

  const weekDaily = await pgrst(
    token,
    "sales",
    `vw_ebo_sales_daily?select=*&store_id=eq.${FIXTURE_STORE}&week_start=eq.${weekStart}`
  );
  if (weekDaily.length === 0) throw new Error(`No vw_ebo_sales_daily rows for week_start=${weekStart}.`);

  const weekly = await pgrst(
    token,
    "sales",
    `vw_ebo_sales_weekly?select=*&store_id=eq.${FIXTURE_STORE}&week_start=eq.${weekStart}`
  );
  const w = weekly[0];
  if (!w) throw new Error(`No vw_ebo_sales_weekly row for ${FIXTURE_STORE}/${weekStart}.`);

  const sum = (rows, col) => rows.reduce((acc, r) => acc + num(r[col]), 0);
  const wkNetSales = sum(weekDaily, "net_sales"); // ALL bill types
  const wkReturnsValue = sum(weekDaily, "returns_value"); // RETURN bills only (0005:105)
  const wkSaleBills = sum(weekDaily, "sale_bills");
  const wkSaleQty = sum(weekDaily, "sale_quantity");
  const wkDiscount = sum(weekDaily, "discount");
  const wkGross = sum(weekDaily, "gross_sales");

  // sale_net_amount (0005:91) is CTE-internal and NOT an output column of the
  // daily view — but it is recoverable exactly, because net_sales is the sum
  // over ALL bill types and returns_value is the RETURN slice of that same
  // sum: sale_net_amount = net_sales - returns_value. The per-day identity
  // check immediately below proves that reconstruction rather than trusting it.
  const wkSaleNetAmount = wkNetSales - wkReturnsValue;

  console.log("\n--- ATV grain: daily-formula vs weekly-formula, same scope ---");
  console.log(`    scope: ${FIXTURE_STORE}, retail week starting ${weekStart} (${weekDaily.length} day rows)`);

  // Identity check: the daily view's own atv column must equal
  // (net_sales - returns_value) / sale_bills on every day that has bills.
  // If this holds, the reconstruction above is sound and the week-level
  // "daily formula" number below is not a guess.
  let identityOk = true;
  for (const row of weekDaily) {
    const bills = num(row.sale_bills);
    if (bills === 0) continue; // atv is NULL on a zero-bill day by design (0005:114)
    const reconstructed = round2((num(row.net_sales) - num(row.returns_value)) / bills);
    if (Math.abs(reconstructed - num(row.atv)) > 0.01) {
      console.error(
        `FAIL  ${row.bill_date}: daily atv column ${row.atv} != (net_sales-returns_value)/sale_bills ${reconstructed}`
      );
      identityOk = false;
    }
  }
  structural.push([
    "sale_net_amount reconstruction",
    assertTrue(
      "daily atv == (net_sales - returns_value) / sale_bills on every day with bills",
      identityOk,
      "confirms the sale-bills-only numerator is recoverable from exposed columns"
    ),
  ]);

  const atvDailyFormula = wkSaleBills > 0 ? round2(wkSaleNetAmount / wkSaleBills) : null;
  const atvWeeklyFormula = wkSaleBills > 0 ? round2(wkNetSales / wkSaleBills) : null;
  console.log(`    daily-formula  ATV (returns EXCLUDED, 0005:106) = ${atvDailyFormula}`);
  console.log(`    weekly-formula ATV (returns NETTED OFF, 0005:133) = ${atvWeeklyFormula}`);
  console.log(`    vw_ebo_sales_weekly.atv as stored              = ${w.atv}`);
  console.log(`    returns_value over scope                       = ${wkReturnsValue}`);

  // The weekly view's stored atv must equal its own documented formula — this
  // is what makes "source_column = weekly.atv" a checkable claim.
  structural.push([
    "weekly.atv == sum(net_sales)/sum(sale_bills)",
    assertClose("weekly.atv re-derived from components", w.atv, atvWeeklyFormula ?? 0, 0.01),
  ]);

  // --- The discriminating case -------------------------------------------
  // returns_value is the whole question. Non-zero => the two formulas MUST
  // diverge and this fixture finally settles the grain question. Zero => they
  // MUST coincide, and this run proves nothing about which one is right.
  const fixtureHasReturns = Math.abs(wkReturnsValue) > 0.005;
  if (fixtureHasReturns) {
    const gap = Math.abs((atvDailyFormula ?? 0) - (atvWeeklyFormula ?? 0));
    structural.push([
      "atv formulas diverge on a returns-bearing scope",
      assertTrue(
        "returns present => daily-formula ATV != weekly-formula ATV",
        gap > 0.01,
        `daily=${atvDailyFormula}, weekly=${atvWeeklyFormula}, gap=${round2(gap)}, returns_value=${wkReturnsValue}`
      ),
    ]);
    banner("FIXTURE CONTAINS RETURN BILLS — THE ATV GRAIN QUESTION IS DISCRIMINATED", [
      `returns_value over scope = ${wkReturnsValue} (non-zero).`,
      `daily-formula ATV  (0005:106, returns excluded) = ${atvDailyFormula}`,
      `weekly-formula ATV (0005:133, returns netted)   = ${atvWeeklyFormula}`,
      "The app renders the WEEKLY figure (web/lib/sales/aggregate.ts:38,100).",
      "'atv' is therefore eligible to be marked is_verified by this run.",
    ]);
  } else {
    structural.push([
      "atv formulas coincide on a zero-returns scope",
      assertTrue(
        "no returns => daily-formula ATV == weekly-formula ATV",
        Math.abs((atvDailyFormula ?? 0) - (atvWeeklyFormula ?? 0)) <= 0.01,
        `both = ${atvWeeklyFormula}`
      ),
    ]);
    banner("READ THIS BEFORE TRUSTING A GREEN RUN: ATV GRAIN IS STILL UNTESTED", [
      `returns_value over ${FIXTURE_STORE} / week ${weekStart} is ${wkReturnsValue} — ZERO.`,
      "With zero RETURN bills the daily formula (sale-bills-only numerator, 0005:106)",
      "and the weekly formula (all-bill-types numerator, 0005:133) are ARITHMETICALLY",
      "IDENTICAL. This fixture CANNOT discriminate them. The PASS above is a check",
      "that they agree where they must agree — it is NOT evidence that the catalogue",
      "points at the right one. That is exactly how migration 0048 shipped the wrong",
      "source_column and a green parity run failed to notice.",
      "",
      "=> 'atv' is EXCLUDED from the is_verified PATCH below and stays is_verified=false.",
      "=> To settle it, seed a fixture with at least one RETURN bill and re-run.",
    ]);
  }

  // --- 0050 repointed atv/upt/discount_pct to the WEEKLY view ---------------
  // Proving the newly-catalogued source_column is the right one = showing the
  // weekly view's stored column equals the documented expression re-derived
  // from components summed off the daily rows it rolls up.
  console.log("--- weekly view columns vs re-derivation from components ---");
  structural.push([
    "weekly.upt",
    assertClose(
      "weekly.upt == sum(sale_quantity)/sum(sale_bills)",
      w.upt,
      wkSaleBills > 0 ? Math.round((wkSaleQty / wkSaleBills) * 1000) / 1000 : 0,
      0.001
    ),
  ]);
  structural.push([
    "weekly.discount_pct",
    assertClose(
      "weekly.discount_pct == 100*sum(discount)/sum(gross_sales)",
      w.discount_pct,
      wkGross > 0 ? round2((100 * wkDiscount) / wkGross) : 0,
      0.02
    ),
  ]);
  // And that the weekly rollup's own component columns really are the daily sums.
  structural.push(["weekly.net_sales rollup", assertClose("weekly.net_sales == sum(daily net_sales)", w.net_sales, wkNetSales, 0.01)]);
  structural.push(["weekly.sale_bills rollup", assertClose("weekly.sale_bills == sum(daily sale_bills)", w.sale_bills, wkSaleBills, 0.01)]);
  structural.push(["weekly.sale_quantity rollup", assertClose("weekly.sale_quantity == sum(daily sale_quantity)", w.sale_quantity, wkSaleQty, 0.01)]);

  // --- Metrics newly registered by 0050: scheme_* and hourly_net_sales -----
  // No independently-confirmed constants exist for these (no page renders a
  // single number from them), so inventing an expected value would be
  // fabricating ground truth. Assert INTERNAL CONSISTENCY against the daily
  // view instead — a real, falsifiable claim about the same underlying bills.
  console.log("--- scheme / hourly views (metrics registered by 0050) ---");

  // vw_ebo_scheme_daily (0005:168) partitions the SAME day's SALE bills across
  // scheme groups, with no-scheme bills carrying the literal 'NO SCHEME' — so
  // it is a complete partition, and the group sums must reconcile EXACTLY to
  // the daily view's SALE-only figures.
  const scheme = await pgrst(
    token,
    "sales",
    `vw_ebo_scheme_daily?select=*&store_id=eq.${FIXTURE_STORE}&bill_date=eq.${FIXTURE_DATE}`
  );
  if (scheme.length === 0) {
    console.error("FAIL  no vw_ebo_scheme_daily rows for the fixture day — expected at least a 'NO SCHEME' group.");
    structural.push(["scheme rows exist", false]);
  } else {
    structural.push(["scheme rows exist", assertTrue("vw_ebo_scheme_daily returned rows", true, `${scheme.length} scheme group(s)`)]);
    structural.push([
      "scheme_quantity reconciles",
      assertClose("sum(scheme quantity) == daily sale_quantity", sum(scheme, "quantity"), num(d.sale_quantity), 0.01),
    ]);
    // Scheme net_sales is SALE-bills-only (0005:177), so it reconciles to the
    // day's sale-bills-only net — net_sales minus returns_value — NOT to net_sales.
    structural.push([
      "scheme_net_sales reconciles",
      assertClose(
        "sum(scheme net_sales) == daily (net_sales - returns_value)",
        sum(scheme, "net_sales"),
        num(d.net_sales) - num(d.returns_value),
        0.01
      ),
    ]);
  }

  // vw_ebo_sales_hourly (0017:27) excludes SALE lines with a null bill_time
  // and says so in its own comment (0017:40-41): rows are ABSENT, not zero.
  // So it is a SUBSET of the day's SALE net — assert <=, never equality.
  // Equality would be asserting that the fixture happens to have bill_time on
  // every line, which is a property of the seed, not of the view.
  const hourly = await pgrst(
    token,
    "sales",
    `vw_ebo_sales_hourly?select=*&store_id=eq.${FIXTURE_STORE}&bill_date=eq.${FIXTURE_DATE}`
  );
  const hourlyNet = sum(hourly, "net_sales");
  const daySaleNet = num(d.net_sales) - num(d.returns_value);
  structural.push([
    "hourly_net_sales is a subset of the day's SALE net",
    assertTrue(
      "sum(hourly net_sales) <= daily (net_sales - returns_value)",
      hourlyNet <= daySaleNet + 0.01,
      `hourly=${hourlyNet} over ${hourly.length} hour bucket(s), daily SALE net=${daySaleNet}`
    ),
  ]);
  if (hourly.length === 0) {
    console.log("      NOTE  zero hourly rows — the fixture's bills have no parseable bill_time.");
  } else if (Math.abs(hourlyNet - daySaleNet) > 0.01) {
    console.log(
      `      NOTE  hourly total is ${round2(daySaleNet - hourlyNet)} short of the day's SALE net — expected when some lines have a null bill_time (0017:37).`
    );
  }

  const structuralFailed = structural.filter(([, ok]) => !ok);
  if (structuralFailed.length > 0) {
    console.error(`\n${structuralFailed.length} structural/grain check(s) failed: ${structuralFailed.map(([l]) => l).join(", ")}`);
  }

  const failed = [...results, ...structural].filter(([, ok]) => !ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} metric(s) failed parity — NOT marking as verified.`);
    process.exit(1);
  }

  console.log(
    `\nAll ${results.length} metrics passed parity against the live-page-confirmed fixture, and all ${structural.length} structural/grain checks passed.`
  );

  // --- Which metrics may be flipped to is_verified -------------------------
  // 'atv' is special: this fixture only discriminates the daily vs weekly
  // formula when it contains a RETURN bill. Without one, a PASS on atv means
  // "700 == 700" under BOTH candidate formulas and says nothing about which
  // source_column the catalogue should name. Marking it verified there is
  // precisely the mistake migration 0050 had to retract, so it is withheld.
  const withheld = [];
  const verifiedIds = results
    .map(([id]) => id)
    .filter((id) => {
      if (id === "atv" && !fixtureHasReturns) {
        withheld.push(id);
        return false;
      }
      // Do not PATCH ids that have no catalogue row (e.g. stack without 0048/0050).
      if (defById.size > 0 && !defById.has(id)) {
        console.warn(`WARN  '${id}' has no workspace.metric_definitions row — skipping its is_verified PATCH (migration 0048/0050 not applied?).`);
        return false;
      }
      return true;
    });

  if (withheld.length > 0) {
    console.log(
      `\nWITHHELD from the is_verified PATCH: ${withheld.join(", ")}\n` +
        `  Reason: the fixture scope (${FIXTURE_STORE} / retail week ${weekStart}) has returns_value = ${wkReturnsValue}.\n` +
        `  With no RETURN bill, sales.vw_ebo_sales_daily.atv and sales.vw_ebo_sales_weekly.atv are\n` +
        `  numerically identical, so passing the atv assertion cannot distinguish them. 'atv' stays\n` +
        `  is_verified = false (as migration 0050 set it) until a returns-bearing fixture exists.`
    );
  }
  // Structural checks above are NOT page parity — they prove two views
  // reconcile, not that a page shows the number. They deliberately grant
  // is_verified to nothing, including the metrics 0050 newly registered.
  console.log(
    "NOTE  scheme_quantity / scheme_net_sales / hourly_net_sales / atv_sale_bills_only are checked for\n" +
      "      internal consistency only and are NOT marked verified — no page renders them as a single\n" +
      "      number, so there is no live-render ground truth to parity-check against."
  );

  if (verifiedIds.length === 0) {
    console.log("\nNo metrics eligible for the is_verified PATCH — nothing to write.");
    return;
  }

  const patchRes = await fetch(
    `${POSTGREST_URL}/metric_definitions?id=in.(${verifiedIds.join(",")})`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Profile": "workspace",
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        is_verified: true,
        verified_against: `scripts/parity-check.mjs fixture (${FIXTURE_STORE}/${FIXTURE_DATE}), cross-checked against app/(ho)/network/page.tsx live render`,
      }),
    }
  );
  if (!patchRes.ok) {
    console.error(`Marking verified failed (${patchRes.status}): ${await patchRes.text()}`);
    console.error("This likely needs the super_admin RLS check on metric_definitions_write — testadmin is super_admin, so if this fails, check the policy.");
    process.exit(1);
  }
  console.log(`Marked ${verifiedIds.length} metrics as is_verified in workspace.metric_definitions: ${verifiedIds.join(", ")}`);
}

main().catch((err) => {
  const code = err?.cause?.code ?? err?.code;
  if (code === "ECONNREFUSED" || code === "ENOTFOUND") {
    console.error(
      `\nCannot reach the local stack (${code}).\n` +
        `  Keycloak:  ${KEYCLOAK_URL}\n` +
        `  PostgREST: ${POSTGREST_URL}\n` +
        "  Start the local dev stack and re-run. Nothing was checked and nothing was marked verified."
    );
    process.exit(1);
  }
  if (typeof err?.message === "string" && /metric_definitions|PGRST20[0-9]|does not exist/i.test(err.message)) {
    console.error(err);
    console.error(
      "\nThis looks like a missing catalogue row or view — migration 0050 not applied? " +
        "Apply server/db/migrations/0050_semantic_layer_grain_corrections.sql (and notify pgrst to reload) and re-run."
    );
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
