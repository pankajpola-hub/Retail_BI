import { Suspense } from "react";
import Link from "next/link";
import { CalendarRange, Clock, Trophy, Users, Tag, ShoppingBag, TrendingUp, TrendingDown } from "lucide-react";
import { createClient } from "@/lib/data/client";
import type { QueryChain } from "@/lib/data/client";
import { requireRole } from "@/lib/auth/roles";
import { resolveViewScope, type VerticalKey } from "@/lib/scope/resolveViewScope";
import { ScopeBar } from "@/components/ui/ScopeBar";
import { KpiCard } from "@/components/ui/KpiCard";
import { TrendChart } from "@/components/ui/TrendChart";
import { HourlyBarChart } from "@/components/ui/HourlyBarChart";
import { MultiSelectFilter } from "@/components/ui/StoreFilter";
import { KpiGridSkeleton, ChartSkeleton, TableSkeleton, SectionLabelSkeleton, MatrixSkeleton } from "@/components/ui/Skeleton";
import { SectionErrorBoundary } from "@/components/ui/SectionErrorBoundary";
import { timeAll } from "@/lib/perf/timing";
import {
  computeSalesTotals,
  computeLeague,
  computeAgentRows,
  computeSchemeRows,
  computeHourlyPoints,
  buildWeekSeries,
  buildDailyPeriodSeries,
  buildMonthlyPeriodSeries,
  buildYearlyPeriodSeries,
  type WeeklyRow,
  type AgentDailyRow,
  type SchemeDailyRow,
  type HourlyRow,
  type DailyFullRow,
  type MonthlyRow,
} from "@/lib/sales/aggregate";
import { computeFootfallInsights, type ConversionRow, type CompletenessRow } from "@/lib/network/footfall";
import { MatrixCell, TrafficSalesCell } from "@/components/ui/FootfallMatrixCells";
import { Pill } from "@/components/ui/Pill";
import { PeriodSalesFacetedTable, type PeriodFacetedRow } from "./PeriodSalesFacetedTable";
import { EcommChannelFacetedTable, type EcommChannelRow } from "./EcommChannelFacetedTable";

/**
 * Card wrapper (2026-08-26 polish pass) — same token pattern KpiCard
 * already established (rounded-lg border border-line-soft bg-surface
 * shadow-sm), applied to every section on this page instead of a bare
 * heading floating over an unwrapped table/chart. `icon` is a small
 * lucide-react glyph (already a dependency, previously unused on this
 * page) giving each heading a visual anchor.
 */
function SectionCard({
  icon,
  title,
  subtitle,
  className = "",
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-lg border border-line-soft bg-surface p-4 shadow-sm ${className}`}>
      <div className="flex items-center gap-1.5 text-ink-3">
        {icon}
        <span className="text-[10.5px] font-semibold uppercase tracking-wide">{title}</span>
      </div>
      {subtitle && <p className="mt-1 text-[11px] text-ink-3">{subtitle}</p>}
      <div className="mt-2">{children}</div>
    </div>
  );
}
// Reused unmodified from the Network page — both are already faceted,
// already handle their own group-by/search, and the Workspace Builder is
// already a second real caller of StoreLeagueFacetedContent's underlying
// StoreLeagueDrilldown. Importing them here rather than re-implementing is
// the same "one definition, several callers" rule the semantic layer
// exists to enforce for metrics.
import { StoreLeagueFacetedContent } from "../network/StoreLeagueFacetedContent";
import { AgentSalesFacetedTable } from "../network/AgentSalesFacetedTable";
import { StoreDiagnosisFacetedTable } from "../network/StoreDiagnosisFacetedTable";

export const dynamic = "force-dynamic";

/**
 * Phase 2 of the unified Sales explore (see the plan file) — one page,
 * any vertical, instead of maintaining /network and /ecomm (soon +2 more
 * for MBO/LFS) as separate pages that each re-render the same KPI-row /
 * trend / breakdown shape. resolveViewScope.ts already models four
 * verticals and ScopeBar already drives a `bu` searchParam — this page is
 * what finally lets that selector control a whole page, not just the
 * rollup cards /network limited it to.
 *
 * THIS FIRST CUT is the SHARED CORE only: revenue, units, discount %, MRP
 * value, daily trend — the metrics that are valid to sum ACROSS verticals,
 * because a bill and an order are comparable at the money level. Vertical-
 * specific sections (EBO footfall/agents/store league, ECOM returns/SKU/
 * channel) are the next step, gated per-section rather than per-page so an
 * ecomm-only user finally sees their own rollup number, which /network's
 * page-level "retail" gate has denied them (see lib/auth/roles.ts's note
 * on testing an ecomm-only marketing user, 2026-08-22).
 *
 * Gate: role-only for now, same list (ho)/layout.tsx already requires — the
 * real narrowing is per-vertical below (resolveViewScope.granted), not a
 * single PAGE_BUSINESS_UNIT the way /network and /ecomm each hard-code one.
 * A user with zero granted verticals sees the page shell with nothing to
 * show, same as /network already handles zero-store scope.
 */

type EboDailyRow = { store_id: string | null; bill_date: string | null; net_sales: number | string; gross_sales: number | string; discount: number | string };
type EcommDailyRow = { channel: string; order_date: string; total_orders: number; net_selling_value: number | string; gross_mrp_value: number | string; discount_value: number | string; units: number };
type StoreRow = { store_id: string; store_name: string };

const INR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const num = (v: number | string) => (typeof v === "string" ? Number(v) : v);

type ApplyStore = <T extends { eq: (col: string, val: string) => T; in: (col: string, vals: string[]) => T }>(
  q: T,
  col?: string
) => T;

async function SharedCoreSection({
  supabase,
  applyStore,
  applyChannel,
  from,
  to,
  showEbo,
  showEcomm,
}: {
  supabase: ReturnType<typeof createClient> extends Promise<infer C> ? C : never;
  applyStore: ApplyStore;
  applyChannel: ApplyStore;
  from: string;
  to: string;
  showEbo: boolean;
  showEcomm: boolean;
}) {
  const [{ data: eboDaily }, { data: ecommDaily }] = await timeAll("sales:shared_core", [
    showEbo
      ? (applyStore(
          supabase.schema("sales").from<EboDailyRow>("vw_ebo_sales_daily").select("store_id, bill_date, net_sales, gross_sales, discount").gte("bill_date", from).lte("bill_date", to)
        ) as unknown as QueryChain<EboDailyRow>)
      : Promise.resolve({ data: [] as EboDailyRow[] }),
    showEcomm
      ? (applyChannel(
          supabase.schema("sales").from<EcommDailyRow>("vw_ecomm_daily").select("channel, order_date, net_selling_value, gross_mrp_value, discount_value, units").gte("order_date", from).lte("order_date", to)
        ) as unknown as QueryChain<EcommDailyRow>)
      : Promise.resolve({ data: [] as EcommDailyRow[] }),
  ] as const);

  const ebo = eboDaily ?? [];
  const ecomm = ecommDaily ?? [];

  // Revenue, discount and MRP are money — comparable across a bill and an
  // order, so summing them across verticals is legitimate. Units are also
  // summed (a unit is a unit regardless of channel). Nothing here is a
  // ratio: ATV/UPT/conversion are vertical-specific and stay out of this
  // section entirely — averaging a bill's ATV with an order's AOV would be
  // a wrong number with nothing visibly broken, the exact failure the
  // planner's grain/store-axis guards exist to prevent elsewhere.
  const eboNet = ebo.reduce((s, r) => s + num(r.net_sales), 0);
  const eboGross = ebo.reduce((s, r) => s + num(r.gross_sales), 0);
  const eboDiscount = ebo.reduce((s, r) => s + num(r.discount), 0);

  const ecommNet = ecomm.reduce((s, r) => s + num(r.net_selling_value), 0);
  const ecommGross = ecomm.reduce((s, r) => s + num(r.gross_mrp_value), 0);
  const ecommDiscount = ecomm.reduce((s, r) => s + num(r.discount_value), 0);
  const ecommUnits = ecomm.reduce((s, r) => s + Number(r.units), 0);

  const netSales = eboNet + ecommNet;
  const grossSales = eboGross + ecommGross;
  const discount = eboDiscount + ecommDiscount;
  const discountPct = grossSales > 0 ? (100 * discount) / grossSales : null;

  // Daily trend — same-day sums across whichever verticals are in scope,
  // one point per date. EBO's bill_date and ECOM's order_date are both
  // already-resolved calendar dates, so keying the merge on the raw string
  // is safe without a timezone conversion.
  const byDate = new Map<string, number>();
  for (const r of ebo) if (r.bill_date) byDate.set(r.bill_date, (byDate.get(r.bill_date) ?? 0) + num(r.net_sales));
  for (const r of ecomm) byDate.set(r.order_date, (byDate.get(r.order_date) ?? 0) + num(r.net_selling_value));
  const trendPoints = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, value]) => ({ label: date, value }));

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard label="Net sales" value={INR(netSales)} sub={showEbo && showEcomm ? `EBO ${INR(eboNet)} + ECOM ${INR(ecommNet)}` : undefined} />
        <KpiCard label="Gross (MRP)" value={INR(grossSales)} />
        <KpiCard label="Discount" value={discountPct !== null ? `${discountPct.toFixed(1)}%` : "—"} sub={INR(discount) + " given"} />
        {showEcomm && <KpiCard label="Ecomm units" value={String(ecommUnits)} />}
        {!showEbo && !showEcomm && <KpiCard label="Net sales" value="—" tone="muted" sub="No vertical selected" />}
      </div>

      <div className="mt-6">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Net sales by day</span>
        <div className="mt-2 border border-line-soft p-3">
          {trendPoints.length > 0 ? (
            <TrendChart points={trendPoints} ariaLabel="Daily net sales across the selected verticals" />
          ) : (
            <p className="py-10 text-center text-sm text-ink-3">No sales data in this window.</p>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * EBO-only detail — store league and agent-wise sales. Renders ONLY when
 * "ebo" is in the active vertical scope; an ecomm-only user never fetches
 * or sees this section at all, which is what a section-level gate actually
 * buys over the page-level one /network hard-codes.
 *
 * Independently streamed from SharedCoreSection (its own Suspense boundary)
 * — same "disclosed duplication for independent streaming" trade-off
 * /network's FootfallSection documents for re-fetching queries
 * SalesSection already ran: this section's own vw_ebo_sales_weekly /
 * vw_ebo_agent_daily queries are cheap, pre-aggregated views, and
 * duplicating them is what lets this section pop in without waiting on
 * SharedCoreSection's daily-grain fetch, or vice versa.
 */
async function EboDetailSection({
  supabase,
  applyStore,
  from,
  to,
  storeNames,
  today,
}: {
  supabase: ReturnType<typeof createClient> extends Promise<infer C> ? C : never;
  applyStore: ApplyStore;
  from: string;
  to: string;
  storeNames: Map<string, string>;
  today: Date;
}) {
  const weeklyStart = new Date(from);
  weeklyStart.setDate(weeklyStart.getDate() - 7);
  // Daily grain only needs one prior day for a DoD baseline (same spirit as
  // weeklyStart's -7 days). Monthly goes back much further (~400 days) so
  // Monthly AND Yearly (derived from these same monthly rows, see below)
  // both get a real prior-period baseline — monthly rows are cheap,
  // pre-aggregated, one row per store per month, so this costs little.
  const dailyStart = new Date(from);
  dailyStart.setDate(dailyStart.getDate() - 1);
  const monthlyStart = new Date(from);
  monthlyStart.setDate(monthlyStart.getDate() - 400);

  const [{ data: weeks }, { data: agentDaily }, { data: hourly }, { data: dailyFull }, { data: monthly }] = await timeAll(
    "sales:ebo_detail",
    [
      applyStore(
        supabase.schema("sales").from<WeeklyRow>("vw_ebo_sales_weekly").select("*").gte("week_start", isoDate(weeklyStart)).lte("week_start", to)
      ) as unknown as QueryChain<WeeklyRow>,
      applyStore(
        supabase.schema("sales").from<AgentDailyRow>("vw_ebo_agent_daily").select("*").gte("bill_date", from).lte("bill_date", to)
      ) as unknown as QueryChain<AgentDailyRow>,
      applyStore(
        supabase.schema("sales").from<HourlyRow>("vw_ebo_sales_hourly").select("*").gte("bill_date", from).lte("bill_date", to)
      ) as unknown as QueryChain<HourlyRow>,
      applyStore(
        supabase.schema("sales").from<DailyFullRow>("vw_ebo_sales_daily").select("*").gte("bill_date", isoDate(dailyStart)).lte("bill_date", to)
      ) as unknown as QueryChain<DailyFullRow>,
      applyStore(
        supabase.schema("sales").from<MonthlyRow>("vw_ebo_sales_monthly").select("*").gte("month_start", isoDate(monthlyStart)).lte("month_start", to)
      ) as unknown as QueryChain<MonthlyRow>,
    ] as const
  );

  const { weekRows, storesInView } = computeSalesTotals(weeks, from);
  const league = computeLeague(weekRows, storesInView, storeNames);
  const agentRows = computeAgentRows(agentDaily);
  const hourlyPoints = computeHourlyPoints(hourly);

  // Flattened once here (server-side) into the shape
  // PeriodSalesFacetedTable actually renders — one row per (store, period),
  // "Network total" just another store-like bucket rather than a special
  // case, per that component's own header. Four grains, one per builder in
  // lib/sales/aggregate.ts, all fed by the queries above — no re-fetch when
  // the user toggles grain client-side.
  const todayStr = isoDate(today);
  const todayMonthStart = todayStr.slice(0, 7) + "-01";
  // "Current" fiscal year for the Yearly grain's isComplete flag — the FY
  // on the most recent monthly row fetched (financial_year isn't on
  // WeeklyRow, so this is derived from the monthly rows already in hand
  // rather than a separate computation).
  const latestMonthlyFy = [...(monthly ?? [])].sort((a, b) => (b.month_start ?? "").localeCompare(a.month_start ?? ""))[0]?.financial_year ?? "";
  const buildRows = <T extends { periodKey: string }>(builder: (storeId: string | null) => T[]) => {
    const perStore = storesInView.flatMap((sid) => builder(sid).map((r) => ({ ...r, storeId: sid, storeName: storeNames.get(sid) ?? sid })));
    if (storesInView.length > 1) {
      perStore.push(...builder(null).map((r) => ({ ...r, storeId: "__network__", storeName: "Network total" })));
    }
    return perStore;
  };
  const weeklyFacetedRows: PeriodFacetedRow[] = buildRows((sid) =>
    buildWeekSeries(weekRows, sid).map((w) => ({
      periodKey: w.weekStart,
      periodLabel: `RW${String(w.retailWeek).padStart(2, "0")}`,
      rangeLabel: `${weekDayLabel(w.weekStart)} – ${weekDayLabel(addDaysIso(w.weekStart, 6))}`,
      net: w.net,
      gross: w.gross,
      discount: w.discount,
      discountPct: w.gross > 0 ? (w.discount / w.gross) * 100 : null,
      bills: w.bills,
      qty: w.qty,
      atv: w.bills > 0 ? w.net / w.bills : null,
      netChangePct: w.netChangePct,
      qtyChangePct: w.qtyChangePct,
      isComplete: w.isCompleteWeek,
    }))
  );
  const dailyFacetedRows: PeriodFacetedRow[] = buildRows((sid) => buildDailyPeriodSeries(dailyFull ?? [], sid, todayStr));
  const monthlyFacetedRows: PeriodFacetedRow[] = buildRows((sid) => buildMonthlyPeriodSeries(monthly ?? [], sid, todayMonthStart));
  const yearlyFacetedRows: PeriodFacetedRow[] = buildRows((sid) => buildYearlyPeriodSeries(monthly ?? [], sid, latestMonthlyFy));

  return (
    <>
      <SectionCard icon={<CalendarRange className="h-4 w-4" />} title="Sales value & quantity by period — EBO">
        <PeriodSalesFacetedTable daily={dailyFacetedRows} weekly={weeklyFacetedRows} monthly={monthlyFacetedRows} yearly={yearlyFacetedRows} />
      </SectionCard>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SectionCard icon={<Clock className="h-4 w-4" />} title="Net sales by hour of day — EBO">
          <HourlyBarChart points={hourlyPoints} ariaLabel="Net sales by hour of day, EBO" />
        </SectionCard>

        <SectionCard icon={<Trophy className="h-4 w-4" />} title="Store league — EBO" subtitle="Click a row for that store's own daily trend.">
          <StoreLeagueFacetedContent league={league} from={from} to={to} />
        </SectionCard>
      </div>

      <SectionCard icon={<Users className="h-4 w-4" />} title="Agent-wise sales — EBO" className="mt-6">
        <AgentSalesFacetedTable rows={agentRows} storeNames={Object.fromEntries(storeNames)} />
      </SectionCard>
    </>
  );
}

const weekDayLabel = (iso: string) => new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function EboDetailSkeleton() {
  return (
    <>
      <SectionLabelSkeleton />
      <TableSkeleton rows={5} cols={6} />
      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartSkeleton height={220} />
        <TableSkeleton rows={6} cols={7} />
      </div>
      <div className="mt-8">
        <SectionLabelSkeleton />
        <TableSkeleton rows={6} cols={6} />
      </div>
    </>
  );
}

/**
 * EBO-only — scheme penetration bar chart. Split from EboDetailSection
 * because it shares nothing with league/agents (a third, independent
 * vw_ebo_scheme_daily fetch) — same "own Suspense boundary so nothing waits
 * on anything else" reasoning /network's sections already establish.
 */
async function SchemePenetrationSection({ supabase, applyStore, from, to }: { supabase: ReturnType<typeof createClient> extends Promise<infer C> ? C : never; applyStore: ApplyStore; from: string; to: string }) {
  const { data: schemeDaily } = await applyStore(
    supabase.schema("sales").from<SchemeDailyRow>("vw_ebo_scheme_daily").select("*").gte("bill_date", from).lte("bill_date", to)
  ) as unknown as { data: SchemeDailyRow[] | null };
  const { schemeRows, schemeMaxQty } = computeSchemeRows(schemeDaily);

  return (
    <SectionCard icon={<Tag className="h-4 w-4" />} title="Scheme penetration (by units sold) — EBO">
      <div className="border border-line-soft p-3">
        <div className="flex flex-col gap-2">
          {schemeRows.map(([group, v]) => (
            <div key={group} className="grid grid-cols-[140px_1fr_auto] items-center gap-3 text-[12.5px]">
              <span className="truncate">{group}</span>
              <span className="h-4 overflow-hidden bg-surface-2">
                <span className="block h-full bg-accent" style={{ width: `${Math.max(2, (v.qty / schemeMaxQty) * 100)}%` }} />
              </span>
              <span className="whitespace-nowrap font-mono text-ink-2">
                {v.qty} units · {INR(v.net)}
              </span>
            </div>
          ))}
          {schemeRows.length === 0 && <p className="text-sm text-ink-3">No scheme data in this window.</p>}
        </div>
      </div>
    </SectionCard>
  );
}

function SchemePenetrationSkeleton() {
  return (
    <>
      <SectionLabelSkeleton />
      <div className="mt-2 h-32 border border-line-soft" />
    </>
  );
}

/**
 * EBO-only — footfall × conversion matrix, traffic vs sales matrix, and
 * store diagnosis & opportunity. Ported verbatim from /network's
 * FootfallSection, which already extracted all derivation into
 * lib/network/footfall.ts's computeFootfallInsights() specifically so the
 * Workspace Builder's footfall components call the same function this page
 * does — this section is the THIRD caller of that same function, not a
 * fourth hand-synced copy.
 *
 * Same deliberate, disclosed query duplication /network documents: daily/
 * weekly/schemeDaily are also fetched by SharedCoreSection/EboDetailSection/
 * SchemePenetrationSection above, and re-fetching here (cheap, pre-
 * aggregated views) is what lets this section stream independently rather
 * than blocking on or going stale relative to the others.
 */
async function FootfallDiagnosisSection({
  supabase,
  applyStore,
  from,
  to,
  storeNames,
  today,
}: {
  supabase: ReturnType<typeof createClient> extends Promise<infer C> ? C : never;
  applyStore: ApplyStore;
  from: string;
  to: string;
  storeNames: Map<string, string>;
  today: Date;
}) {
  const periodDays = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1;
  const prevTo = new Date(from);
  prevTo.setDate(prevTo.getDate() - 1);
  const prevFrom = new Date(prevTo);
  prevFrom.setDate(prevFrom.getDate() - (periodDays - 1));
  const weeklyStart = new Date(from);
  weeklyStart.setDate(weeklyStart.getDate() - 7);

  const [{ data: conversion }, { data: prevConversion }, { data: completeness }, { data: daily }, { data: weeks }, { data: schemeDaily }] = await timeAll(
    "sales:footfall_diagnosis",
    [
      applyStore(supabase.schema("ops").from<ConversionRow>("vw_ebo_conversion_daily").select("store_id, bill_date, footfall, sale_bills, net_sales").gte("bill_date", from).lte("bill_date", to) as unknown as QueryChain<ConversionRow>),
      applyStore(supabase.schema("ops").from<ConversionRow>("vw_ebo_conversion_daily").select("store_id, bill_date, footfall, sale_bills, net_sales").gte("bill_date", isoDate(prevFrom)).lte("bill_date", isoDate(prevTo)) as unknown as QueryChain<ConversionRow>),
      applyStore(supabase.schema("ops").from<CompletenessRow>("vw_footfall_completeness").select("store_id, date, has_footfall").gte("date", from).lte("date", to) as unknown as QueryChain<CompletenessRow>),
      applyStore(supabase.schema("sales").from<EboDailyRow>("vw_ebo_sales_daily").select("*").gte("bill_date", from).lte("bill_date", to).order("bill_date") as unknown as QueryChain<EboDailyRow>),
      applyStore(supabase.schema("sales").from<WeeklyRow>("vw_ebo_sales_weekly").select("*").gte("week_start", isoDate(weeklyStart)).lte("week_start", to).order("week_start") as unknown as QueryChain<WeeklyRow>),
      applyStore(supabase.schema("sales").from<SchemeDailyRow>("vw_ebo_scheme_daily").select("*").gte("bill_date", from).lte("bill_date", to) as unknown as QueryChain<SchemeDailyRow>),
    ] as const
  );

  const { footfallDaysCovered, matrixEntries, matrixInsufficientData, storeDiagnosis } = computeFootfallInsights({
    conversion,
    prevConversion,
    completeness,
    daily,
    weeks,
    schemeDaily,
    storeNames,
    today,
    from,
    prevFrom,
    prevTo,
  });

  return (
    <>
      <div className="flex items-baseline justify-between">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
          Footfall × conversion matrix — EBO
        </span>
        <span className="text-[11.5px] text-ink-3">
          vs {isoDate(prevFrom)} – {isoDate(prevTo)}
        </span>
      </div>

      {footfallDaysCovered > 0 ? (
        <>
          <div className="mt-2 overflow-x-auto border border-line-soft">
            <div className="grid min-w-[560px] grid-cols-[90px_1fr_1fr] gap-px bg-line-soft text-[12.5px]">
              <div className="bg-surface-2" />
              <div className="bg-surface-2 px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wide text-ink-3">Conversion up</div>
              <div className="bg-surface-2 px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wide text-ink-3">Conversion down</div>

              <div className="flex items-center justify-center bg-surface-2 px-2 text-center text-[10px] font-semibold uppercase tracking-wide text-ink-3">Footfall up</div>
              <MatrixCell quadrant="healthy" entries={matrixEntries} />
              <MatrixCell quadrant="conversion_opportunity" entries={matrixEntries} />

              <div className="flex items-center justify-center bg-surface-2 px-2 text-center text-[10px] font-semibold uppercase tracking-wide text-ink-3">Footfall down</div>
              <MatrixCell quadrant="marketing_opportunity" entries={matrixEntries} />
              <MatrixCell quadrant="critical" entries={matrixEntries} />
            </div>
          </div>
          {matrixInsufficientData.length > 0 && (
            <p className="mt-2 text-[12px] text-ink-3">
              Not placed (missing footfall in this or the comparison period): {matrixInsufficientData.join(", ")}
            </p>
          )}
        </>
      ) : (
        <div className="mt-2 border border-line-soft bg-surface-2 p-6 text-center">
          <Pill tone="neutral">No footfall entered yet</Pill>
          <p className="mt-2 text-sm text-ink-3">
            This grid needs daily footfall entry to place any store on it — see{" "}
            <a href="/footfall" className="underline">the footfall entry screen</a>. Nothing here is guessed in the meantime.
          </p>
        </div>
      )}

      {matrixEntries.length > 0 && (
        <div className="mt-8">
          <div className="flex items-baseline justify-between">
            <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
              Traffic vs sales matrix — EBO
            </span>
            <span className="text-[11px] text-ink-3">
              {isoDate(prevFrom)} – {isoDate(prevTo)} → {from} – {to}
            </span>
          </div>
          <p className="mt-1 text-[11.5px] text-ink-3">
            Is traffic turning into money? Separate question from the grid above, which asks which lever moved.
          </p>
          <div className="mt-2 overflow-x-auto border border-line-soft">
            <div className="grid min-w-[560px] grid-cols-[90px_1fr_1fr] gap-px bg-line-soft text-[12.5px]">
              <div className="bg-surface-2" />
              <div className="bg-surface-2 px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wide text-ink-3">Sales up</div>
              <div className="bg-surface-2 px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wide text-ink-3">Sales down</div>

              <div className="flex items-center justify-center bg-surface-2 px-2 text-center text-[10px] font-semibold uppercase tracking-wide text-ink-3">Footfall up</div>
              <TrafficSalesCell quadrant="growth_engine" entries={matrixEntries} />
              <TrafficSalesCell quadrant="efficiency_opportunity" entries={matrixEntries} />

              <div className="flex items-center justify-center bg-surface-2 px-2 text-center text-[10px] font-semibold uppercase tracking-wide text-ink-3">Footfall down</div>
              <TrafficSalesCell quadrant="positive_efficiency" entries={matrixEntries} />
              <TrafficSalesCell quadrant="traffic_problem" entries={matrixEntries} />
            </div>
          </div>
        </div>
      )}

      {storeDiagnosis.length > 0 && (
        <div className="mt-8">
          <div className="flex items-baseline justify-between">
            <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
              Store diagnosis &amp; opportunity — EBO
            </span>
            <span className="text-[11px] text-ink-3">
              vs {isoDate(prevFrom)} – {isoDate(prevTo)}
            </span>
          </div>
          <div className="mt-2">
            <StoreDiagnosisFacetedTable rows={storeDiagnosis} />
          </div>
          <p className="mt-2 text-[11.5px] text-ink-3">
            Opportunity is an <strong>estimate</strong>: what this store&apos;s sales would have been at its own
            prior-period footfall and the better of its two conversion rates, minus actual — a single combined
            ceiling, not traffic and conversion opportunities added together. Benchmarks are the store&apos;s own
            previous period. Stock is not a factor — no stock feed exists.
          </p>
        </div>
      )}
    </>
  );
}

function FootfallDiagnosisSkeleton() {
  return (
    <>
      <SectionLabelSkeleton />
      <MatrixSkeleton />
      <div className="mt-8">
        <TableSkeleton rows={5} cols={8} />
      </div>
    </>
  );
}

type EcommLineRow = { channel: string; item_sku: string; style: string | null; status: string; selling_price: number | string; mrp: number | string; discount: number | string };
type EcommReturnRow = { reverse_pickup_code: string; status: string | null; return_date: string };

/**
 * ECOM-only detail — channel breakdown, top styles, and returns. Same
 * section-level gate as EboDetailSection; ported from app/(ecomm)/ecomm's
 * existing logic, including that page's channel drill-down (?channel=):
 * clicking a channel row scopes the SKU table (and the lines query itself,
 * DB-level — the whole point of the drill-down is to avoid pulling every
 * channel's line items when only one is wanted) to that channel, while the
 * by-channel table itself always stays unfiltered so a row is always
 * clickable to switch or clear.
 */
async function EcommDetailSection({
  supabase,
  applyChannel,
  from,
  to,
  channel,
  channelHref,
}: {
  supabase: ReturnType<typeof createClient> extends Promise<infer C> ? C : never;
  applyChannel: ApplyStore;
  from: string;
  to: string;
  channel: string | null;
  channelHref: (target: string | null) => string;
}) {
  // applyChannel (the page-level ScopeBar scope, `channels` param) is
  // applied to all three queries below so the filter narrows everything on
  // this page consistently — the row-click drill-down (`channel`, singular)
  // is a further single-channel zoom ON TOP of that, applied after.
  let linesQuery = applyChannel(
    supabase
      .schema("sales")
      .from<EcommLineRow>("vw_ecomm_order_lines")
      .select("channel, item_sku, style, status, selling_price, mrp, discount")
      .gte("order_date", from)
      .lte("order_date", to)
  ) as unknown as QueryChain<EcommLineRow>;
  if (channel) linesQuery = linesQuery.eq("channel", channel) as unknown as QueryChain<EcommLineRow>;

  const [{ data: dailyRows }, { data: lineRows }, { data: returnRows }] = await timeAll("sales:ecomm_detail", [
    applyChannel(
      supabase.schema("sales").from<EcommDailyRow>("vw_ecomm_daily").select("*").gte("order_date", from).lte("order_date", to)
    ) as unknown as QueryChain<EcommDailyRow>,
    linesQuery,
    applyChannel(
      supabase.schema("sales").from<EcommReturnRow>("vw_ecomm_returns").select("reverse_pickup_code, status, return_date").gte("return_date", from).lte("return_date", to)
    ) as unknown as QueryChain<EcommReturnRow>,
  ] as const);

  const daily = dailyRows ?? [];
  const lines = lineRows ?? [];
  const returns = returnRows ?? [];

  const byChannel = new Map<string, { orders: number; cancelled: number; units: number; net: number; mrp: number; discount: number }>();
  for (const r of daily) {
    const c = byChannel.get(r.channel) ?? { orders: 0, cancelled: 0, units: 0, net: 0, mrp: 0, discount: 0 };
    c.orders += Number(r.total_orders);
    c.units += Number(r.units);
    c.net += num(r.net_selling_value);
    c.mrp += num(r.gross_mrp_value);
    c.discount += num(r.discount_value);
    byChannel.set(r.channel, c);
  }
  const channelRows = [...byChannel.entries()].sort((a, b) => b[1].net - a[1].net);

  const bySku = new Map<string, { key: string; units: number; net: number; mrp: number; discount: number }>();
  for (const l of lines) {
    const key = (l.style && l.style.trim()) || l.item_sku || "Unknown SKU";
    const s = bySku.get(key) ?? { key, units: 0, net: 0, mrp: 0, discount: 0 };
    s.units += 1;
    if (l.status !== "CANCELLED") s.net += num(l.selling_price);
    s.mrp += num(l.mrp);
    s.discount += num(l.discount);
    bySku.set(key, s);
  }
  const topSkuRows = [...bySku.values()].sort((a, b) => b.net - a.net).slice(0, 20);

  const byReturnStatus = new Map<string, number>();
  for (const r of returns) {
    const key = r.status ?? "(no status)";
    byReturnStatus.set(key, (byReturnStatus.get(key) ?? 0) + 1);
  }
  const returnStatusRows = [...byReturnStatus.entries()].sort((a, b) => b[1] - a[1]);

  const ecommChannelRows: EcommChannelRow[] = channelRows.map(([ch, c]) => ({
    channel: ch,
    orders: c.orders,
    cancelled: c.cancelled,
    cancellationRate: c.orders > 0 ? (100 * c.cancelled) / c.orders : null,
    units: c.units,
    net: c.net,
    mrp: c.mrp,
    discountPct: c.mrp > 0 ? (100 * c.discount) / c.mrp : null,
  }));

  return (
    <>
      <SectionCard
        icon={<ShoppingBag className="h-4 w-4" />}
        title={`By channel — ECOM${channel ? ` — ${channel}` : ""}`}
        subtitle="Click a channel for its own SKU breakdown."
      >
        {channel && (
          <div className="mb-2 flex justify-end">
            <Link href={channelHref(null)} className="text-[11.5px] text-accent underline">
              Clear channel filter
            </Link>
          </div>
        )}
        <EcommChannelFacetedTable rows={ecommChannelRows} activeChannel={channel} channelHref={channelHref} />
      </SectionCard>

      <SectionCard
        icon={<Tag className="h-4 w-4" />}
        title={`Top styles — ECOM${channel ? ` — ${channel}` : ""}`}
        subtitle="Only order lines that have finished Uniware item-enrichment — see /ecomm for the full incomplete-data caveat."
        className="mt-6"
      >
      <div className="overflow-x-auto border border-line-soft">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line-soft bg-surface-2 text-left text-[10px] uppercase tracking-wide text-ink-3">
              <th className="px-3 py-2">Style</th>
              <th className="px-3 py-2 text-right">Units</th>
              <th className="px-3 py-2 text-right">Net revenue</th>
            </tr>
          </thead>
          <tbody>
            {topSkuRows.map((s) => (
              <tr key={s.key} className="border-b border-line-soft last:border-0">
                <td className="px-3 py-2">{s.key}</td>
                <td className="px-3 py-2 text-right font-mono">{s.units}</td>
                <td className="px-3 py-2 text-right font-mono">{INR(s.net)}</td>
              </tr>
            ))}
            {topSkuRows.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-4 text-center text-sm text-ink-3">No enriched order lines in this range.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      </SectionCard>

      <SectionCard icon={<CalendarRange className="h-4 w-4" />} title="Returns — ECOM" className="mt-6">
      <div className="overflow-x-auto border border-line-soft">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line-soft bg-surface-2 text-left text-[10px] uppercase tracking-wide text-ink-3">
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 text-right">Returns</th>
            </tr>
          </thead>
          <tbody>
            {returnStatusRows.map(([status, count]) => (
              <tr key={status} className="border-b border-line-soft last:border-0">
                <td className="px-3 py-2">{status}</td>
                <td className="px-3 py-2 text-right font-mono">{count}</td>
              </tr>
            ))}
            {returnStatusRows.length === 0 && (
              <tr>
                <td colSpan={2} className="px-3 py-4 text-center text-sm text-ink-3">No returns in this range.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      </SectionCard>
    </>
  );
}

function EcommDetailSkeleton() {
  return (
    <>
      <SectionLabelSkeleton />
      <TableSkeleton rows={4} cols={4} />
      <div className="mt-8">
        <SectionLabelSkeleton />
        <TableSkeleton rows={6} cols={3} />
      </div>
    </>
  );
}

function SharedCoreSkeleton() {
  return (
    <>
      <KpiGridSkeleton count={5} />
      <div className="mt-6">
        <SectionLabelSkeleton />
        <ChartSkeleton height={160} />
      </div>
    </>
  );
}

export default async function SalesPage({
  searchParams,
}: {
  searchParams: { from?: string; to?: string; store?: string; bu?: string; channel?: string; channels?: string };
}) {
  // Role-only gate for this first cut — see the file header for why the real
  // narrowing is per-vertical (resolveViewScope.granted) rather than one
  // page-level business_unit the way /network and /ecomm each hard-code.
  const user = await requireRole("ho_admin", "regional_manager", "super_admin", "ebo_manager", "marketing");
  const { verticals } = resolveViewScope(user);

  const selectedVerticals = (searchParams.bu ?? "").split(",").filter(Boolean) as VerticalKey[];
  const grantedKeys = new Set(verticals.filter((v) => v.granted && v.pipelineConnected).map((v) => v.key));
  // Empty selection = "all verticals this user has", same convention the
  // rollup cards on /network already established.
  const activeVerticals = selectedVerticals.length > 0 ? selectedVerticals.filter((v) => grantedKeys.has(v)) : [...grantedKeys];
  const showEbo = activeVerticals.includes("ebo");
  const showEcomm = activeVerticals.includes("ecomm");

  const supabase = await createClient();

  const today = new Date();
  const defaultFrom = new Date(today);
  defaultFrom.setDate(defaultFrom.getDate() - 29);
  const from = searchParams.from ?? isoDate(defaultFrom);
  const to = searchParams.to ?? isoDate(today);

  const storeFilters = (searchParams.store ?? "").split(",").filter(Boolean);
  const applyStore: ApplyStore = (q, col = "store_id") => {
    if (storeFilters.length === 0) return q;
    if (storeFilters.length === 1) return q.eq(col, storeFilters[0] as string);
    return q.in(col, storeFilters);
  };

  // Ecomm channel SCOPE filter (2026-08-26, Pankaj) — separate URL param
  // (`channels`, plural) from the pre-existing single-value `channel` drill-
  // down below, so the two don't collide: this one is the ScopeBar-level
  // "which channels am I even looking at" scope (same role `store`/
  // applyStore plays for EBO, applied to every ecomm query below), the
  // drill-down is a row-click zoom-in on top of whatever this has already
  // narrowed to.
  const channelFilters = (searchParams.channels ?? "").split(",").filter(Boolean);
  const applyChannel: ApplyStore = (q, col = "channel") => {
    if (channelFilters.length === 0) return q;
    if (channelFilters.length === 1) return q.eq(col, channelFilters[0] as string);
    return q.in(col, channelFilters);
  };

  // Ecomm channel drill-down — URL state, ported from app/(ecomm)/ecomm's own
  // channelHref, so clicking a channel row scopes the SKU table without
  // losing the page's vertical/store/date/channels-scope selections.
  const channel = searchParams.channel || null;
  function channelHref(target: string | null) {
    const params = new URLSearchParams();
    if (searchParams.bu) params.set("bu", searchParams.bu);
    if (searchParams.store) params.set("store", searchParams.store);
    if (searchParams.channels) params.set("channels", searchParams.channels);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (target) params.set("channel", target);
    const qs = params.toString();
    return qs ? `/sales?${qs}` : "/sales";
  }

  // Store picker only makes sense while EBO is in scope — ecomm has no store
  // axis at all (see queryPlanner.ts's VIEW_STORE_COLUMN null entries for
  // vw_ecomm_*), so showing it while only ECOM is selected would offer a
  // control that narrows nothing.
  const { data: stores } = showEbo
    ? await supabase.schema("core").from<StoreRow>("stores").select("store_id, store_name").order("store_id")
    : { data: [] as StoreRow[] };

  // Channel picker — mirror-opposite of the store picker: only fetched
  // while ECOM is in scope. Small, cacheable distinct list (a handful of
  // marketplace names), deduped client-side rather than reaching for a
  // dedicated distinct-value RPC for such a small result set.
  const { data: channelRowsRaw } = showEcomm
    ? await supabase.schema("sales").from<{ channel: string }>("vw_ecomm_daily").select("channel").order("channel")
    : { data: [] as { channel: string }[] };
  const allChannels = [...new Set((channelRowsRaw ?? []).map((r) => r.channel).filter(Boolean))];
  const activeStores = (stores ?? []).filter((s) => s.store_id !== "BO-004" && s.store_id !== "BO-002");
  const storeNames = new Map(activeStores.map((s) => [s.store_id, s.store_name]));

  // Plain-language restatement of the active scope — "which numbers am I
  // looking at" as a fact on screen, not a guess from the filter bar alone
  // (2026-08-26 layout recommendation, Pankaj).
  const activeVerticalLabels = verticals.filter((v) => activeVerticals.includes(v.key)).map((v) => v.label);
  const scopeSummary = [
    activeVerticalLabels.length > 0 ? activeVerticalLabels.join(" + ") : "No vertical selected",
    `${from} to ${to}`,
    showEbo ? (storeFilters.length > 0 ? `${storeFilters.length} store${storeFilters.length > 1 ? "s" : ""}` : "all stores") : null,
    showEcomm ? (channelFilters.length > 0 ? `${channelFilters.length} channel${channelFilters.length > 1 ? "s" : ""}` : "all channels") : null,
  ].filter(Boolean).join(" · ");

  return (
    <main className="py-6">
      <h1 className="font-serif text-2xl">Sales</h1>
      <p className="mt-1 text-[12.5px] text-ink-3">
        Every vertical you have access to, in one place — choose which to view below.
      </p>
      <p className="mt-1.5 text-[11.5px] font-medium text-ink-2">Showing: {scopeSummary}</p>

      <div className="mt-3">
        <ScopeBar
          verticals={verticals}
          selectedVerticals={selectedVerticals}
          from={from}
          to={to}
          locationSlot={
            showEbo ? (
              <MultiSelectFilter
                paramName="store"
                options={activeStores.map((s) => s.store_id)}
                labels={Object.fromEntries(activeStores.map((s) => [s.store_id, s.store_name]))}
                selected={storeFilters}
                allLabel="All stores"
              />
            ) : showEcomm ? (
              <MultiSelectFilter
                paramName="channels"
                options={allChannels}
                selected={channelFilters}
                allLabel="All channels"
              />
            ) : (
              <span className="text-[12.5px] text-ink-3">— (select a vertical)</span>
            )
          }
        />
      </div>

      <SectionErrorBoundary label="Sales overview">
        <Suspense fallback={<SharedCoreSkeleton />}>
          <div className="mt-6">
            <SharedCoreSection
              supabase={supabase}
              applyStore={applyStore}
              applyChannel={applyChannel}
              from={from}
              to={to}
              showEbo={showEbo}
              showEcomm={showEcomm}
            />
          </div>
        </Suspense>
      </SectionErrorBoundary>

      {showEbo && (
        <div className="mt-10">
          <div className="flex items-center gap-3">
            <h2 className="font-serif text-lg text-ink">EBO</h2>
            <div className="h-px flex-1 bg-line-soft" />
          </div>

          <SectionErrorBoundary label="EBO detail">
            <Suspense fallback={<EboDetailSkeleton />}>
              <div className="mt-4">
                <EboDetailSection supabase={supabase} applyStore={applyStore} from={from} to={to} storeNames={storeNames} today={today} />
              </div>
            </Suspense>
          </SectionErrorBoundary>

          <SectionErrorBoundary label="Footfall & diagnosis">
            <Suspense fallback={<FootfallDiagnosisSkeleton />}>
              <div className="mt-8">
                <FootfallDiagnosisSection supabase={supabase} applyStore={applyStore} from={from} to={to} storeNames={storeNames} today={today} />
              </div>
            </Suspense>
          </SectionErrorBoundary>

          <SectionErrorBoundary label="Scheme penetration">
            <Suspense fallback={<SchemePenetrationSkeleton />}>
              <div className="mt-8">
                <SchemePenetrationSection supabase={supabase} applyStore={applyStore} from={from} to={to} />
              </div>
            </Suspense>
          </SectionErrorBoundary>
        </div>
      )}

      {showEcomm && (
        <div className="mt-10">
          <div className="flex items-center gap-3">
            <h2 className="font-serif text-lg text-ink">ECOM</h2>
            <div className="h-px flex-1 bg-line-soft" />
            {channelFilters.length > 0 && (
              <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-[11px] font-medium text-accent-ink">
                {channelFilters.join(", ")}
              </span>
            )}
          </div>

          <SectionErrorBoundary label="Ecomm detail">
            <Suspense fallback={<EcommDetailSkeleton />}>
              <div className="mt-4">
                <EcommDetailSection
                  supabase={supabase}
                  applyChannel={applyChannel}
                  from={from}
                  to={to}
                  channel={channel}
                  channelHref={channelHref}
                />
              </div>
            </Suspense>
          </SectionErrorBoundary>
        </div>
      )}
    </main>
  );
}
