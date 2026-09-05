import type { DataClient, QueryChain } from "@/lib/data/client";
import { KpiCard } from "@/components/ui/KpiCard";
import { DeltaBadge } from "@/components/ui/DeltaBadge";
import { TrendChart } from "@/components/ui/TrendChart";
import { HourlyBarChart } from "@/components/ui/HourlyBarChart";
import {
  computeSalesTotals,
  computeLeague,
  computeSchemeRows,
  computeTrendPoints,
  computeHourlyPoints,
  computeAgentRows,
  buildWeekSeries,
  buildDailyPeriodSeries,
  buildMonthlyPeriodSeries,
  buildYearlyPeriodSeries,
  HOUR_START,
  HOUR_END,
  type DailyRow,
  type WeeklyRow,
  type DailyFullRow,
  type MonthlyRow,
  type PeriodRow,
  type SchemeDailyRow,
  type HourlyRow,
  type AgentDailyRow,
} from "@/lib/sales/aggregate";
import { timeAll } from "@/lib/perf/timing";
import { StoreLeagueDrilldown } from "@/app/(workspace)/workspace/StoreLeagueDrilldown";
import { PeriodSalesFacetedTable, type PeriodFacetedRow } from "@/app/(ho)/sales/PeriodSalesFacetedTable";
import type { MetricDefinition, DimensionDefinition } from "@/lib/workspace/semantic";
import { planQueries, buildQuery, isSatisfiable, type QueryRequirement, type DimensionPredicate } from "@/lib/workspace/queryPlanner";

/**
 * Phase 5 — the first components rendered FROM saved workspace config
 * instead of hand-written page JSX. Reuses the exact fetch shape and the
 * exact shared aggregate functions (lib/sales/aggregate.ts) the Network
 * page's SalesSection uses (Phase 1), so a value shown here and the same
 * value shown on /network can never disagree.
 *
 * Query-planner usage is SPLIT, deliberately. Three of the four fetches
 * below (daily / scheme / hourly) go through the Phase 4 planner
 * (lib/workspace/queryPlanner.ts); the WEEKLY one stays hand-written.
 *
 * The three that are planned are each single-view, single-grain, exact-match
 * cases — one metric id resolves to one view and one column, no
 * re-derivation, nothing ambiguous for the planner to get wrong. Routing
 * them through it also narrows the select list from `*` to named columns,
 * which is the point at 100+ stores.
 *
 * The WEEKLY fetch cannot be planned yet, and the reason is a real modelling
 * gap rather than laziness: workspace.metric_definitions gives each metric
 * exactly ONE source_view, but net_sales / gross_sales / discount_value /
 * sale_bills / sale_quantity genuinely exist at BOTH the daily and weekly
 * grain with the same meaning, and are catalogued against the daily view. A
 * requirement naming them would therefore resolve to vw_ebo_sales_daily —
 * the wrong view for a week series. Expressing "this metric exists at these
 * grains, roll up via this view" is the next real Phase 4 design step; until
 * it exists, planning the weekly fetch would silently query the wrong grain.
 *
 * Related and now fixed: migration 0050 repointed atv/upt/discount_pct from
 * the daily view to the weekly one. ATV in particular was catalogued against
 * sales.vw_ebo_sales_daily.atv, whose numerator is sale-bills-only, while
 * every page renders the WEEKLY definition whose numerator nets off returns
 * (0005:106 vs 0005:133). Those two agree only when a scope has no return
 * bills — which is exactly why the parity fixture never caught it. See that
 * migration's header for the full account.
 *
 * All components below share ONE fetchSalesComponentData() call per page
 * render (workspace/page.tsx calls it once, not once per added component,
 * regardless of how many of these are on the workspace) — see that file's
 * own `salesDataPromise` comment for how that single call now streams to
 * each grid item independently instead of blocking the whole page.
 *
 * D-05 parity (2026-08-27) added two more grains (Daily full-column, Monthly)
 * to the fetch below so WeeklySalesTable could swap onto the same
 * PeriodSalesFacetedTable component sales/page.tsx uses — see that
 * component's own header comment for the full port rationale.
 */

export type SalesComponentScope = {
  supabase: DataClient;
  storeIds: string[];
  from: string;
  to: string;
  weeklyStart: string;
  /**
   * "Now", as the caller's page render saw it — threaded through rather than
   * computed fresh in here so a mid-render clock tick can't disagree with
   * whatever the rest of the page already decided "today" is. Only used for
   * the Daily/Monthly/Yearly grains' isComplete flags (buildDailyPeriodSeries
   * etc.), mirroring app/(ho)/sales/page.tsx's EboDetailSection.
   */
  today: Date;
  /**
   * D-05 parity item 1 — period comparison, both-or-neither (same convention
   * as sales/page.tsx's compareFrom/compareTo URL params). Null/null means
   * "no comparison active", the default — the extra query below is only
   * issued when both are set.
   */
  compareFrom: string | null;
  compareTo: string | null;
  /**
   * The workspace.metric_definitions rows this module plans against, keyed by
   * id — fetched by the CALLER alongside its own registry read so the
   * semantic-layer lookup shares that round trip instead of adding one.
   * A missing id degrades that one fetch to its hand-written form rather
   * than failing the page; see plannedOrFallback().
   */
  metricsById: Map<string, MetricDefinition>;
  /** workspace.dimension_definitions rows, for resolving Phase 6 governed filters. Same caller-fetches-it rationale as metricsById. */
  dimensionsById: Map<string, DimensionDefinition>;
  /**
   * Phase 6 governed filters beyond store/date, as saved on the workspace.
   * Applied by the planner where the dimension resolves to a column on the
   * queried view; a filter that cannot be applied fails the component loudly
   * rather than rendering unfiltered data (see plannedOrFallback).
   */
  dimensionFilters: DimensionPredicate[];
};

/** Metric ids this module needs from the semantic layer. The caller fetches exactly these. */
export const PLANNED_METRIC_IDS = ["net_sales", "scheme_quantity", "scheme_net_sales", "hourly_net_sales"] as const;

export type SalesComponentData = ReturnType<typeof deriveSalesComponentData>;

/**
 * Plan `requirement` and execute it — or, if the semantic layer can't cover
 * it, run `fallback` instead. A missing metric row (a stack without
 * migration 0048/0050 applied) degrades that ONE fetch to the hand-written
 * query it used before rather than failing the page, matching this page's
 * existing per-component failure posture.
 *
 * A requirement that resolves to more than one physical query would mean a
 * multi-view fetch, which none of the callers here intend — treated as
 * unplannable and sent to the fallback rather than silently running only the
 * first query.
 */
function plannedOrFallback<T>(
  supabase: DataClient,
  metricsById: Map<string, MetricDefinition>,
  dimensionsById: Map<string, DimensionDefinition>,
  requirement: QueryRequirement,
  fallback: () => PromiseLike<{ data: T[] | null }>
): PromiseLike<{ data: T[] | null }> {
  const available = new Map<string, MetricDefinition>();
  for (const id of requirement.metricIds) {
    const metric = metricsById.get(id);
    if (!metric) return fallback();
    available.set(id, metric);
  }
  const planned = planQueries([requirement], available, dimensionsById);
  // isSatisfiable() covers unplannable metrics AND dimension filters that
  // resolved to no column on this view. The latter matters most: a dropped
  // filter would render unfiltered rows as though they were filtered, so an
  // unsatisfiable plan must never fall through to the hand-written query
  // either — that query doesn't know about the filter at all.
  if (planned.length !== 1) return fallback();
  const [only] = planned;
  if (only!.unappliedDimensionIds.length > 0) {
    throw new Error(
      `Workspace filter(s) [${only!.unappliedDimensionIds.join(", ")}] cannot be applied to ${only!.sourceView}. ` +
        `Refusing to render this component with unfiltered data.`
    );
  }
  if (!isSatisfiable(only!)) return fallback();
  return buildQuery<T>(supabase, only!);
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
// Same formatting as sales/page.tsx (:525-530) — kept in sync by inspection
// since that file is a page module this one deliberately doesn't import from.
const weekDayLabel = (iso: string) => new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function fetchRaw(scope: SalesComponentScope) {
  const { supabase, storeIds, from, to, weeklyStart, compareFrom, compareTo, metricsById, dimensionsById, dimensionFilters } = scope;
  const applyStore = <T extends { eq: (c: string, v: string) => T; in: (c: string, v: string[]) => T }>(q: T): T => {
    if (storeIds.length === 0) return q;
    if (storeIds.length === 1) return q.eq("store_id", storeIds[0]!);
    return q.in("store_id", storeIds);
  };
  const period = { from, to };
  const comparing = Boolean(compareFrom && compareTo);
  // Comparison window's own weekly lookback — same -7 days rule as the
  // primary weeklyStart the caller (workspace/page.tsx) precomputes, applied
  // here since compareFrom is only known inside this scope.
  const compareWeeklyStart = comparing ? new Date(compareFrom as string) : null;
  if (compareWeeklyStart) compareWeeklyStart.setDate(compareWeeklyStart.getDate() - 7);
  // Daily/Monthly grain windows for the period-faceted table — exactly the
  // same lookback sales/page.tsx's EboDetailSection uses (:363-366): one day
  // back gives Daily a DoD baseline, ~400 days back gives Monthly (and
  // Yearly, which reuses these same monthly rows) a real prior-period one.
  const dailyStart = new Date(from);
  dailyStart.setDate(dailyStart.getDate() - 1);
  const monthlyStart = new Date(from);
  monthlyStart.setDate(monthlyStart.getDate() - 400);
  // One filters object shared by all three planned requirements, so a
  // governed filter can never be applied to one component and forgotten on
  // another within the same render.
  const filters = { storeIds, dimensions: dimensionFilters };

  // The weekly fetch below is hand-written and therefore knows nothing about
  // governed dimension filters. If one is active that the weekly view cannot
  // express, the KPI grid / league table / week series would silently render
  // UNFILTERED numbers next to a correctly-filtered scheme or hourly chart —
  // the same class of "two things on one screen disagree" bug the semantic
  // layer exists to prevent. Fail loudly instead.
  //
  // In practice this cannot fire today: nothing in the UI can save a filter
  // other than store/date yet, so dimensionFilters is always empty. It is a
  // tripwire for whoever ships the governed-filter UI — at that point either
  // the weekly fetch gets planned too (needs the multi-grain metric work
  // described in this file's header) or weekly-backed components must opt out
  // of dimensions they cannot honour.
  const weeklyUnsupported = dimensionFilters
    .filter((f) => f.values.length > 0)
    .filter((f) => dimensionsById.get(f.dimensionId)?.sourceView !== "sales.vw_ebo_sales_weekly")
    .map((f) => f.dimensionId);
  if (weeklyUnsupported.length > 0) {
    throw new Error(
      `Workspace filter(s) [${weeklyUnsupported.join(", ")}] cannot be applied to sales.vw_ebo_sales_weekly, ` +
        `which backs the KPI grid, store league and weekly table. Refusing to render those with unfiltered data.`
    );
  }

  const [{ data: daily }, { data: weeks }, { data: schemeDaily }, { data: hourly }, { data: agentDaily }, { data: dailyFull }, { data: monthly }, { data: compareWeeks }] = await timeAll(
    "workspace:sales-components",
    [
      plannedOrFallback<DailyRow>(
        supabase,
        metricsById,
        dimensionsById,
        ({ componentId: "sales_trend_chart", metricIds: ["net_sales"], period, comparison: "none", filters }),
        () =>
          applyStore(
            supabase.schema("sales").from<DailyRow>("vw_ebo_sales_daily").select("store_id,bill_date,net_sales").gte("bill_date", from).lte("bill_date", to).order("bill_date") as unknown as QueryChain<DailyRow>
          )
      ),
      // NOT planned — see this file's header (metric_definitions can only
      // name one grain per metric, and these are catalogued at the daily one).
      applyStore(supabase.schema("sales").from<WeeklyRow>("vw_ebo_sales_weekly").select("*").gte("week_start", weeklyStart).lte("week_start", to).order("week_start") as unknown as QueryChain<WeeklyRow>),
      plannedOrFallback<SchemeDailyRow>(
        supabase,
        metricsById,
        dimensionsById,
        // scheme_group is the grouping key computeSchemeRows() reduces on —
        // a column of vw_ebo_scheme_daily (0005:172), not a metric.
        ({ componentId: "scheme_penetration", metricIds: ["scheme_quantity", "scheme_net_sales"], period, comparison: "none", filters, extraColumns: ["scheme_group"] }),
        () =>
          applyStore(supabase.schema("sales").from<SchemeDailyRow>("vw_ebo_scheme_daily").select("*").gte("bill_date", from).lte("bill_date", to) as unknown as QueryChain<SchemeDailyRow>)
      ),
      plannedOrFallback<HourlyRow>(
        supabase,
        metricsById,
        dimensionsById,
        // bill_hour is the bucket key computeHourlyPoints() reduces on
        // (0017:32), not a metric.
        ({ componentId: "hourly_sales_chart", metricIds: ["hourly_net_sales"], period, comparison: "none", filters, extraColumns: ["bill_hour"] }),
        () =>
          applyStore(supabase.schema("sales").from<HourlyRow>("vw_ebo_sales_hourly").select("*").gte("bill_date", from).lte("bill_date", to) as unknown as QueryChain<HourlyRow>)
      ),
      // NOT planned — agent_sales_table groups by agent+store, and there's
      // no metric_definitions row modelling that grain, same reason the
      // weekly fetch above stays hand-written.
      applyStore(supabase.schema("sales").from<AgentDailyRow>("vw_ebo_agent_daily").select("*").gte("bill_date", from).lte("bill_date", to) as unknown as QueryChain<AgentDailyRow>),
      // Daily/Monthly grain — added for the period-faceted table's grain
      // toggle (D-05 parity items 3/4/5). NOT planned, same reason as weekly
      // above: these are wide, full-column reads (atv/discount_pct already
      // computed server-side by the view), not a single named metric.
      applyStore(
        supabase.schema("sales").from<DailyFullRow>("vw_ebo_sales_daily").select("*").gte("bill_date", isoDate(dailyStart)).lte("bill_date", to) as unknown as QueryChain<DailyFullRow>
      ),
      applyStore(
        supabase.schema("sales").from<MonthlyRow>("vw_ebo_sales_monthly").select("*").gte("month_start", isoDate(monthlyStart)).lte("month_start", to) as unknown as QueryChain<MonthlyRow>
      ),
      // D-05 parity item 1 — ONE extra query for the whole comparison strip,
      // issued only when a comparison range is actually active (same
      // both-or-neither gate as sales/page.tsx's EboDetailSection :390-394).
      // The weekly view already carries every metric the KPI grid shows
      // (net/gross/discount/bills/qty), so no second daily/monthly fetch is
      // needed just to compare — same reasoning as that section's own comment.
      comparing
        ? (applyStore(
            supabase.schema("sales").from<WeeklyRow>("vw_ebo_sales_weekly").select("*").gte("week_start", isoDate(compareWeeklyStart as Date)).lte("week_start", compareTo as string) as unknown as QueryChain<WeeklyRow>
          ))
        : Promise.resolve({ data: [] as WeeklyRow[] }),
    ] as const
  );

  return { daily, weeks, schemeDaily, hourly, agentDaily, dailyFull, monthly, compareWeeks, comparing };
}

/**
 * Flattens one grain's builder output into one row per (store, period), plus
 * a synthetic "Network total" bucket when more than one store is in view —
 * same shape/rule as sales/page.tsx's EboDetailSection buildRows(), so the
 * faceted table's "Network total" summary block behaves identically on both
 * pages. Duplicated rather than imported from sales/page.tsx because that
 * file is a page module (not a lib), same reasoning already documented for
 * this file's own applyStore() vs sales/page.tsx's.
 */
function buildPeriodRows<T extends PeriodRow>(
  storesInView: string[],
  storeNames: Map<string, string>,
  builder: (storeId: string | null) => T[]
): PeriodFacetedRow[] {
  const perStore: PeriodFacetedRow[] = storesInView.flatMap((sid) =>
    builder(sid).map((r) => ({ ...r, storeId: sid, storeName: storeNames.get(sid) ?? sid }))
  );
  if (storesInView.length > 1) {
    perStore.push(...builder(null).map((r) => ({ ...r, storeId: "__network__", storeName: "Network total" })));
  }
  return perStore;
}

function deriveSalesComponentData(
  raw: Awaited<ReturnType<typeof fetchRaw>>,
  storeNames: Map<string, string>,
  from: string,
  to: string,
  today: Date,
  compareFrom: string | null,
  compareTo: string | null
) {
  const totals = computeSalesTotals(raw.weeks, from);
  // D-05 parity item 1 — same function (computeSalesTotals), second window,
  // never a parallel formula. Mirrors sales/page.tsx's EboDetailSection
  // (:402) exactly, including reading the comparison weeks off the SAME
  // weekly view the primary totals use.
  const compareTotals = raw.comparing && compareFrom ? computeSalesTotals(raw.compareWeeks, compareFrom) : null;
  const league = computeLeague(totals.weekRows, totals.storesInView, storeNames);
  const { schemeRows, schemeMaxQty } = computeSchemeRows(raw.schemeDaily);
  const trendPoints = computeTrendPoints(raw.daily);
  const hourlyPoints = computeHourlyPoints(raw.hourly);

  // Four pre-computed grain row-sets for the period-faceted table — same
  // builders, same window logic, same "Network total" bucket rule as
  // sales/page.tsx's EboDetailSection (:409-446).
  const { storesInView } = totals;
  const todayStr = isoDate(today);
  const todayMonthStart = todayStr.slice(0, 7) + "-01";
  const latestMonthlyFy =
    [...(raw.monthly ?? [])].sort((a, b) => (b.month_start ?? "").localeCompare(a.month_start ?? ""))[0]?.financial_year ?? "";
  const weeklyPeriodRows = buildPeriodRows(storesInView, storeNames, (sid) =>
    buildWeekSeries(totals.weekRows, sid).map((w) => ({
      periodKey: w.weekStart,
      periodLabel: `RW${String(w.retailWeek).padStart(2, "0")}`,
      rangeLabel: `${weekDayLabel(w.weekStart)} – ${weekDayLabel(addDaysIso(w.weekStart, 6))}`,
      net: w.net,
      gross: w.gross,
      discount: w.discount,
      discountPct: w.gross > 0 ? (w.discount / w.gross) * 100 : null,
      bills: w.bills,
      qty: w.qty,
      // 0 here, not a computed split: this path reads the pre-aggregated
      // sales.vw_ebo_sales_weekly, which carries no discount per LINE, so
      // there is nothing to classify. buildWeekSeries passes 0 through, and
      // this caller leaves PeriodSalesFacetedTable's showQtySplit off, so the
      // table renders the single "Qty" column it always did rather than an
      // invented "all Fresh" reading. /sales' own trend table reads lines and
      // does get the real split. (Workspace parity is tracked as D-05.)
      freshQty: w.freshQty,
      eossQty: w.eossQty,
      atv: w.bills > 0 ? w.net / w.bills : null,
      netChangePct: w.netChangePct,
      qtyChangePct: w.qtyChangePct,
      isComplete: w.isCompleteWeek,
    }))
  );
  const dailyPeriodRows = buildPeriodRows(storesInView, storeNames, (sid) => buildDailyPeriodSeries(raw.dailyFull ?? [], sid, todayStr));
  const monthlyPeriodRows = buildPeriodRows(storesInView, storeNames, (sid) => buildMonthlyPeriodSeries(raw.monthly ?? [], sid, todayMonthStart));
  const yearlyPeriodRows = buildPeriodRows(storesInView, storeNames, (sid) => buildYearlyPeriodSeries(raw.monthly ?? [], sid, latestMonthlyFy));
  const agentRows = computeAgentRows(raw.agentDaily);
  return {
    totals,
    compareTotals,
    compareFrom,
    compareTo,
    league,
    schemeRows,
    schemeMaxQty,
    trendPoints,
    hourlyPoints,
    agentRows,
    storeNames,
    periodFrom: from,
    periodTo: to,
    dailyPeriodRows,
    weeklyPeriodRows,
    monthlyPeriodRows,
    yearlyPeriodRows,
  };
}

export async function fetchSalesComponentData(scope: SalesComponentScope, storeNames: Map<string, string>) {
  const raw = await fetchRaw(scope);
  return deriveSalesComponentData(raw, storeNames, scope.from, scope.to, scope.today, scope.compareFrom, scope.compareTo);
}

const INR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/**
 * D-05 parity item 1 (2026-08-27) — `delta={<DeltaBadge .../>}` threaded
 * exactly as sales/page.tsx's EboDetailSection comparison strip does
 * (:462-499): rendered only when data.compareTotals is set (comparison
 * active), Discount % uses mode="pp" + invert (a RISING discount rate is
 * bad news, and a percentage's own change is percentage POINTS, not a
 * percent-of-a-percent), every other card uses the "pct" default.
 */
export function SalesKpiGrid({ data }: { data: SalesComponentData }) {
  const { totalNetSales, totalGrossSales, discountPct, totalDiscount, totalSaleBills, totalSaleQty, salesPerUnit, networkAtv, networkUpt } = data.totals;
  const cmp = data.compareTotals;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <KpiCard
        label="Net sales"
        value={INR(totalNetSales)}
        sub={`gross ${INR(totalGrossSales)}`}
        delta={cmp && <DeltaBadge current={totalNetSales} previous={cmp.totalNetSales} baselineLabel={`vs ${INR(cmp.totalNetSales)}`} />}
      />
      <KpiCard
        label="Discount"
        value={discountPct !== null ? `${discountPct.toFixed(1)}%` : "—"}
        sub={INR(totalDiscount) + " given"}
        delta={
          cmp && (
            <DeltaBadge
              current={discountPct}
              previous={cmp.discountPct}
              mode="pp"
              invert
              baselineLabel={cmp.discountPct !== null ? `vs ${cmp.discountPct.toFixed(1)}%` : "vs —"}
            />
          )
        }
      />
      <KpiCard
        label="Sale bills"
        value={String(totalSaleBills)}
        delta={cmp && <DeltaBadge current={totalSaleBills} previous={cmp.totalSaleBills} baselineLabel={`vs ${cmp.totalSaleBills}`} />}
      />
      <KpiCard
        label="Units sold"
        value={String(totalSaleQty)}
        sub={salesPerUnit !== null ? `${INR(salesPerUnit)}/unit` : undefined}
        delta={cmp && <DeltaBadge current={totalSaleQty} previous={cmp.totalSaleQty} baselineLabel={`vs ${cmp.totalSaleQty}`} />}
      />
      <KpiCard
        label="ATV"
        value={networkAtv !== null ? INR(networkAtv) : "—"}
        delta={cmp && <DeltaBadge current={networkAtv} previous={cmp.networkAtv} baselineLabel={cmp.networkAtv !== null ? `vs ${INR(cmp.networkAtv)}` : "vs —"} />}
      />
      <KpiCard
        label="UPT"
        value={networkUpt !== null ? networkUpt.toFixed(2) : "—"}
        delta={cmp && <DeltaBadge current={networkUpt} previous={cmp.networkUpt} baselineLabel={cmp.networkUpt !== null ? `vs ${cmp.networkUpt.toFixed(2)}` : "vs —"} />}
      />
    </div>
  );
}

/**
 * D-05 parity items 3/4/5 (2026-08-27) — full swap from the old per-store
 * `<table>` blocks (WeeklyRowDrilldown, Weekly-only) to the shared
 * PeriodSalesFacetedTable component sales/page.tsx's EboDetailSection
 * renders, now that fetchRaw() above fetches all four grains.
 *
 * EXPLICIT DECISION (audit's own item 4, docs/audit/D-frontend.md): this is
 * the full swap, not the "widen WeeklyRowDrilldown's columns instead" option
 * the audit also offered. Reasoning: the user's literal ask was "all
 * features of sales are not available on Workspace, copy all there" — parity
 * with Sales, not a second diverging table design. The swap costs the
 * per-row click-to-drill (WeeklyRowDrilldown -> getStoreDrilldownTrend); in
 * exchange this table gains 3 more grains, faceting/group-by/saved views,
 * sorting, and 8 more columns (gross, discount %, bills, qty, qty change) the
 * old table never had. That trade reads as a net gain for "copy all
 * features", not a wash — and Store League (StoreLeagueTable, below) still
 * offers its own row-click drilldown into a store's daily trend, so the
 * drilldown INTERACTION isn't lost from the page, just from this one table.
 *
 * `pageKey="workspace_period"` (distinct from Sales' own "sales_period",
 * PeriodSalesFacetedTable.tsx:19/367) so a saved facet/group-by view on one
 * page never collides with or overwrites the other's.
 */
export function WeeklySalesTable({ data }: { data: SalesComponentData }) {
  return (
    <PeriodSalesFacetedTable
      daily={data.dailyPeriodRows}
      weekly={data.weeklyPeriodRows}
      monthly={data.monthlyPeriodRows}
      yearly={data.yearlyPeriodRows}
      pageKey="workspace_period"
    />
  );
}

export function SalesTrendChart({ data }: { data: SalesComponentData }) {
  return data.trendPoints.length > 0 ? (
    <TrendChart points={data.trendPoints} ariaLabel="Daily net sales across the network" />
  ) : (
    <p className="py-10 text-center text-sm text-ink-3">No sales data in this window.</p>
  );
}

export function HourlySalesChart({ data }: { data: SalesComponentData }) {
  return data.hourlyPoints.length > 0 ? (
    <HourlyBarChart points={data.hourlyPoints} ariaLabel="Net sales by hour of day, 9am to midnight" startHour={HOUR_START} endHour={HOUR_END} />
  ) : (
    <p className="py-10 text-center text-sm text-ink-3">No bill-time data in this window.</p>
  );
}

export function StoreLeagueTable({ data }: { data: SalesComponentData }) {
  // Phase 8 — clicking a row opens a focus panel with that store's own daily
  // trend, fetched on demand (getStoreDrilldownTrend, lib/workspace/drilldown.ts)
  // only when opened, never as part of this page's initial render. The static
  // league summary itself stays exactly as it was — only the added click
  // affordance and its lazy detail query are new.
  return <StoreLeagueDrilldown league={data.league} from={data.periodFrom} to={data.periodTo} />;
}

export function SchemePenetration({ data }: { data: SalesComponentData }) {
  return (
    <div className="flex flex-col gap-2 overflow-y-auto">
      {data.schemeRows.map(([group, v]) => (
        <div key={group} className="grid grid-cols-[120px_1fr_auto] items-center gap-3 text-[12.5px]">
          <span className="truncate">{group}</span>
          <span className="h-4 overflow-hidden bg-surface-2">
            <span className="block h-full bg-accent" style={{ width: `${Math.max(2, (v.qty / data.schemeMaxQty) * 100)}%` }} />
          </span>
          <span className="whitespace-nowrap font-mono text-ink-2">{v.qty} units</span>
        </div>
      ))}
      {data.schemeRows.length === 0 && <p className="text-sm text-ink-3">No scheme data in this window.</p>}
    </div>
  );
}

export function AgentSalesTable({ data }: { data: SalesComponentData }) {
  return (
    <div className="overflow-x-auto overflow-y-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line-soft bg-surface-2 text-left text-[10px] uppercase tracking-wide text-ink-3">
            <th className="px-3 py-2">Agent</th>
            <th className="px-3 py-2">Store</th>
            <th className="px-3 py-2 text-right">Bills</th>
            <th className="px-3 py-2 text-right">Units</th>
            <th className="px-3 py-2 text-right">Net</th>
            <th className="px-3 py-2 text-right">ATV</th>
          </tr>
        </thead>
        <tbody>
          {data.agentRows.map((v) => (
            <tr key={`${v.storeId}-${v.agent}`} className="border-b border-line-soft last:border-0">
              <td className="px-3 py-2">{v.agent}</td>
              <td className="px-3 py-2 text-ink-3">{data.storeNames.get(v.storeId) ?? v.storeId}</td>
              <td className="px-3 py-2 text-right font-mono">{v.bills}</td>
              <td className="px-3 py-2 text-right font-mono">{v.qty}</td>
              <td className="px-3 py-2 text-right font-mono">{INR(v.net)}</td>
              <td className="px-3 py-2 text-right font-mono">{v.bills > 0 ? INR(v.net / v.bills) : "—"}</td>
            </tr>
          ))}
          {data.agentRows.length === 0 && (
            <tr>
              <td colSpan={6} className="px-3 py-4 text-center text-sm text-ink-3">No agent data in this window.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export const SALES_COMPONENT_RENDERERS: Record<string, (props: { data: SalesComponentData }) => JSX.Element> = {
  sales_kpi_grid: SalesKpiGrid,
  weekly_sales_table: WeeklySalesTable,
  sales_trend_chart: SalesTrendChart,
  hourly_sales_chart: HourlySalesChart,
  store_league_table: StoreLeagueTable,
  scheme_penetration: SchemePenetration,
  agent_sales_table: AgentSalesTable,
};
