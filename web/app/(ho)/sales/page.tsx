import { Suspense } from "react";
import Link from "next/link";
import { CalendarRange, Clock, Trophy, Users, Tag, ShoppingBag, TrendingUp, TrendingDown, Shirt } from "lucide-react";
import { createClient, fetchAllRows } from "@/lib/data/client";
import type { QueryChain } from "@/lib/data/client";
import { requirePageAccess } from "@/lib/auth/roles";
import { resolveViewScope, type VerticalKey } from "@/lib/scope/resolveViewScope";
import { ownStores } from "@/lib/scope/ownStores";
import { ScopeBar } from "@/components/ui/ScopeBar";
import { KpiCard } from "@/components/ui/KpiCard";
import { TrendChart } from "@/components/ui/TrendChart";
import { ComparisonTrendChart } from "@/components/ui/ComparisonTrendChart";
import { DeltaBadge } from "@/components/ui/DeltaBadge";
import { MultiSelectFilter } from "@/components/ui/StoreFilter";
import { KpiGridSkeleton, ChartSkeleton, TableSkeleton, SectionLabelSkeleton, MatrixSkeleton } from "@/components/ui/Skeleton";
import { SectionErrorBoundary } from "@/components/ui/SectionErrorBoundary";
import { timeAll } from "@/lib/perf/timing";
import {
  computeSalesTotals,
  buildWeekSeries,
  buildDailyPeriodSeries,
  buildMonthlyPeriodSeries,
  buildYearlyPeriodSeries,
  type WeeklyRow,
  type SchemeDailyRow,
} from "@/lib/sales/aggregate";
import { computeFootfallInsights, type ConversionRow, type CompletenessRow } from "@/lib/network/footfall";
import { MatrixCell, TrafficSalesCell } from "@/components/ui/FootfallMatrixCells";
import { Pill } from "@/components/ui/Pill";
import { PeriodSalesFacetedTable, grainForRange, type PeriodFacetedRow } from "./PeriodSalesFacetedTable";
import { EcommChannelFacetedTable, type EcommChannelRow } from "./EcommChannelFacetedTable";
import { ProductAttributeSalesTable } from "./ProductAttributeSalesTable";
import type { SaleAttributeLineRow } from "@/lib/sales/attributeBreakdown";
import { HourlyWithComparison, SchemePenetrationBars, StoreLeagueComparison } from "./EboAttributeBlockViews";
import {
  SALE_LINE_SELECT,
  applyAttributeFilter,
  buildAttributeOptions,
  describeAttributeSelection,
  isAttributeSelectionEmpty,
  type SaleLineRow,
} from "@/lib/sales/attributeFilter";
import {
  computeAgentRowsFromLines,
  computeHourlyFromLines,
  computeLeagueFromLines,
  computeSchemeFromLines,
  computeQtySplitFromLines,
  computeTotalsFromLines,
  computeTrendFromLines,
} from "@/lib/sales/lineAggregates";
import { linesToDailyRows, linesToWeeklyRows, linesToMonthlyRows } from "@/lib/sales/lineRollups";
import { resolveTableScope } from "@/lib/sales/tableScope";
import { TableScopeBar } from "./TableScopeBar";

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
 * URL param prefixes, one per independent filter surface on this page.
 *
 * Every independently-filterable block writes its state to the same URL, so
 * each needs its own namespace or they clobber each other. Same fix and same reasoning as movement/page.tsx's `mix_` prefix
 * — see AttributeFilterBar's header. Collected here rather than inlined so the
 * whole set is visible at once and a new one can't accidentally duplicate an
 * existing prefix.
 */
const SHARED_ATTR_PREFIX = "attr_";
/**
 * The shared block (Net sales by day / Hour of day / Store league / Scheme
 * penetration) owns a full scope of its own — Location + Period + Compare +
 * Attributes — rather than only the attribute bar SHARED_ATTR_PREFIX used to
 * carry. SHARED_ATTR_PREFIX is kept as that block's prefix so a URL already
 * carrying `attr_cat=...` keeps working; the new date/store/compare params
 * land in the SAME namespace, which is what lets one TableScopeBar drive all
 * four controls for the block. See resolveTableScope's fallback rule.
 */
const SHARED_BLOCK_PREFIX = SHARED_ATTR_PREFIX;
// "periodTable_" split in two (2026-09-05). TREND_TABLE_PREFIX keeps the old
// name so any bookmarked ?periodTable_from=... still lands on the trend table,
// which is the half that kept the old behaviour; the comparison half is new
// and gets a new namespace.
const TREND_TABLE_PREFIX = "periodTable_";
const COMPARE_TABLE_PREFIX = "compareTable_";
const AGENT_TABLE_PREFIX = "agentTable_";
const ATTR_TABLE_PREFIX = "attrTable_";
const FOOTFALL_PREFIX = "footfall_";

/**
 * Builds an ApplyStore for a table's OWN store selection, independent of the
 * page-level one. Same eq/in shape as the page-level applyStore — store
 * scoping is never bypassed, it is only ever narrowed further; the underlying
 * view is already RLS-scoped by core.fn_user_store_ids().
 */
function applyStoreFor(storeFilters: string[]): ApplyStore {
  return (q, col = "store_id") => {
    if (storeFilters.length === 0) return q;
    if (storeFilters.length === 1) return q.eq(col, storeFilters[0] as string);
    return q.in(col, storeFilters);
  };
}

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

// sale_quantity (not net_quantity) is the units figure this page already
// treats as "units" everywhere else — computeSalesTotals' totalSaleQty, the
// EBO comparison strip's "Units" card and every buildPeriodSeries all sum
// sale_quantity. Using it here too keeps the shared-core "EBO units" card
// reconciling against the EBO block's own Units card rather than differing
// from it by the returned quantity.
type EboDailyRow = { store_id: string | null; bill_date: string | null; net_sales: number | string; gross_sales: number | string; discount: number | string; sale_quantity: number | string };
// cancelled_orders comes from sales.vw_ecomm_daily's orders_agg
// (`count(*) filter (where o.status = 'CANCELLED')`). It was always in the
// view but was never selected or typed here, which is why the Ecomm "By
// channel" table's Cancelled / Cancel % columns rendered a constant 0.
type EcommDailyRow = { channel: string; order_date: string; total_orders: number; cancelled_orders: number | string; net_selling_value: number | string; gross_mrp_value: number | string; discount_value: number | string; units: number };
type StoreRow = { store_id: string; store_name: string; is_active: boolean };

const INR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const num = (v: number | string) => (typeof v === "string" ? Number(v) : v);

type ApplyStore = <T extends { eq: (col: string, val: string) => T; in: (col: string, vals: string[]) => T }>(
  q: T,
  col?: string
) => T;

/**
 * Shared-core roll-up for ONE date window. Extracted (2026-08-26, period
 * comparison) purely so the exact same arithmetic runs over the current and
 * the comparison window — the comparison numbers are never derived by a
 * second, parallel formula. Same rule lib/sales/aggregate.ts's header states
 * for the EBO metrics: one definition, several callers.
 */
function rollUpCore(ebo: EboDailyRow[], ecomm: EcommDailyRow[]) {
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
  const eboUnits = ebo.reduce((s, r) => s + num(r.sale_quantity ?? 0), 0);

  const ecommNet = ecomm.reduce((s, r) => s + num(r.net_selling_value), 0);
  const ecommGross = ecomm.reduce((s, r) => s + num(r.gross_mrp_value), 0);
  const ecommDiscount = ecomm.reduce((s, r) => s + num(r.discount_value), 0);
  const ecommUnits = ecomm.reduce((s, r) => s + Number(r.units), 0);

  const netSales = eboNet + ecommNet;
  const grossSales = eboGross + ecommGross;
  const discount = eboDiscount + ecommDiscount;

  // Daily trend — same-day sums across whichever verticals are in scope,
  // one point per date. EBO's bill_date and ECOM's order_date are both
  // already-resolved calendar dates, so keying the merge on the raw string
  // is safe without a timezone conversion.
  const byDate = new Map<string, number>();
  for (const r of ebo) if (r.bill_date) byDate.set(r.bill_date, (byDate.get(r.bill_date) ?? 0) + num(r.net_sales));
  for (const r of ecomm) byDate.set(r.order_date, (byDate.get(r.order_date) ?? 0) + num(r.net_selling_value));
  // `date` (raw ISO) is what ComparisonTrendChart/TrendChart's time scale
  // zooms and pans against since the 2026-08-29 lightweight-charts swap;
  // `label` stays the tooltip's display text. Additive, see computeTrendPoints.
  const trendPoints = [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, value]) => ({ label: date, value, date }));

  return {
    eboNet,
    ecommNet,
    eboUnits,
    ecommUnits,
    netSales,
    grossSales,
    discount,
    discountPct: grossSales > 0 ? (100 * discount) / grossSales : null,
    trendPoints,
  };
}

async function SharedCoreSection({
  supabase,
  applyStore,
  applyChannel,
  from,
  to,
  compareFrom,
  compareTo,
  showEbo,
  showEcomm,
}: {
  supabase: ReturnType<typeof createClient> extends Promise<infer C> ? C : never;
  applyStore: ApplyStore;
  applyChannel: ApplyStore;
  from: string;
  to: string;
  compareFrom: string | null;
  compareTo: string | null;
  showEbo: boolean;
  showEcomm: boolean;
}) {
  // Period comparison doubles this section's fetch — so the two comparison
  // queries are only ISSUED when a comparison range is actually set (and,
  // independently, only for the verticals in scope). With no comparison
  // active this array is byte-for-byte the two queries it always was; the
  // resolved-empty placeholders cost nothing.
  const comparing = Boolean(compareFrom && compareTo);
  // All four go through fetchAllRows(): PostgREST's project-level "Max Rows"
  // caps every response at 1000 rows regardless of .limit(), so a bare await
  // silently truncated any window whose daily grain exceeded that (multi-store
  // EBO reaches it inside a year) — making a WIDER date range report LOWER Net
  // Sales than a narrower one. The .order() calls are load-bearing, not
  // cosmetic: .range() paging is only a correct partition if the server-side
  // ordering is stable across the separate REST calls. Same pattern as the
  // attribute-lines query below.
  const eboSelect = "store_id, bill_date, net_sales, gross_sales, discount, sale_quantity";
  const ecommSelect = "channel, order_date, total_orders, cancelled_orders, net_selling_value, gross_mrp_value, discount_value, units";
  const [eboDaily, ecommDaily, cmpEboDaily, cmpEcommDaily] = await timeAll("sales:shared_core", [
    showEbo
      ? fetchAllRows<EboDailyRow>(
          () =>
            applyStore(
              supabase.schema("sales").from<EboDailyRow>("vw_ebo_sales_daily").select(eboSelect).gte("bill_date", from).lte("bill_date", to)
            ).order("bill_date", { ascending: true }).order("store_id", { ascending: true }) as unknown as QueryChain<EboDailyRow>
        )
      : Promise.resolve([] as EboDailyRow[]),
    showEcomm
      ? fetchAllRows<EcommDailyRow>(
          () =>
            applyChannel(
              supabase.schema("sales").from<EcommDailyRow>("vw_ecomm_daily").select(ecommSelect).gte("order_date", from).lte("order_date", to)
            ).order("order_date", { ascending: true }).order("channel", { ascending: true }) as unknown as QueryChain<EcommDailyRow>
        )
      : Promise.resolve([] as EcommDailyRow[]),
    showEbo && comparing
      ? fetchAllRows<EboDailyRow>(
          () =>
            applyStore(
              supabase.schema("sales").from<EboDailyRow>("vw_ebo_sales_daily").select(eboSelect).gte("bill_date", compareFrom as string).lte("bill_date", compareTo as string)
            ).order("bill_date", { ascending: true }).order("store_id", { ascending: true }) as unknown as QueryChain<EboDailyRow>
        )
      : Promise.resolve([] as EboDailyRow[]),
    showEcomm && comparing
      ? fetchAllRows<EcommDailyRow>(
          () =>
            applyChannel(
              supabase.schema("sales").from<EcommDailyRow>("vw_ecomm_daily").select(ecommSelect).gte("order_date", compareFrom as string).lte("order_date", compareTo as string)
            ).order("order_date", { ascending: true }).order("channel", { ascending: true }) as unknown as QueryChain<EcommDailyRow>
        )
      : Promise.resolve([] as EcommDailyRow[]),
  ] as const);

  const cur = rollUpCore(eboDaily ?? [], ecommDaily ?? []);
  const cmp = comparing ? rollUpCore(cmpEboDaily ?? [], cmpEcommDaily ?? []) : null;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard
          label="Net sales"
          value={INR(cur.netSales)}
          delta={cmp && <DeltaBadge current={cur.netSales} previous={cmp.netSales} baselineLabel={`vs ${INR(cmp.netSales)}`} />}
          sub={showEbo && showEcomm ? `EBO ${INR(cur.eboNet)} + ECOM ${INR(cur.ecommNet)}` : undefined}
        />
        <KpiCard
          label="Gross (MRP)"
          value={INR(cur.grossSales)}
          delta={cmp && <DeltaBadge current={cur.grossSales} previous={cmp.grossSales} baselineLabel={`vs ${INR(cmp.grossSales)}`} />}
        />
        <KpiCard
          label="Discount"
          value={cur.discountPct !== null ? `${cur.discountPct.toFixed(1)}%` : "—"}
          // A discount RATE is itself a percentage, so its change is shown in
          // percentage points, and a rising discount rate is bad news — hence
          // mode="pp" + invert, not a naive percent-of-a-percent in green.
          delta={
            cmp && (
              <DeltaBadge
                current={cur.discountPct}
                previous={cmp.discountPct}
                mode="pp"
                invert
                baselineLabel={cmp.discountPct !== null ? `vs ${cmp.discountPct.toFixed(1)}%` : "vs —"}
              />
            )
          }
          sub={INR(cur.discount) + " given"}
        />
        {/* Two separate unit cards, not one combined "Units" — a bill's unit
            and an order's unit are countable the same way, but the page has
            never shown a cross-vertical unit total and inventing one here
            would be a new metric. Same shape Net/Gross already use for
            multi-vertical (one figure, per-vertical detail alongside). */}
        {showEbo && (
          <KpiCard
            label="EBO units"
            value={cur.eboUnits.toLocaleString("en-IN")}
            delta={cmp && <DeltaBadge current={cur.eboUnits} previous={cmp.eboUnits} baselineLabel={`vs ${cmp.eboUnits.toLocaleString("en-IN")}`} />}
          />
        )}
        {showEcomm && (
          <KpiCard
            label="Ecomm units"
            value={String(cur.ecommUnits)}
            delta={cmp && <DeltaBadge current={cur.ecommUnits} previous={cmp.ecommUnits} baselineLabel={`vs ${cmp.ecommUnits}`} />}
          />
        )}
        {!showEbo && !showEcomm && <KpiCard label="Net sales" value="—" tone="muted" sub="No vertical selected" />}
      </div>

      <div className="mt-6">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Net sales by day</span>
        <div className="mt-2 border border-line-soft p-3">
          {cur.trendPoints.length === 0 && (!cmp || cmp.trendPoints.length === 0) ? (
            <p className="py-10 text-center text-sm text-ink-3">No sales data in this window.</p>
          ) : cmp ? (
            <ComparisonTrendChart
              current={cur.trendPoints}
              comparison={cmp.trendPoints}
              from={from}
              to={to}
              compareFrom={compareFrom as string}
              compareTo={compareTo as string}
              ariaLabel="Daily net sales across the selected verticals, current period against the comparison period"
            />
          ) : (
            <TrendChart points={cur.trendPoints} ariaLabel="Daily net sales across the selected verticals" />
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
  compareFrom,
  compareTo,
}: {
  supabase: ReturnType<typeof createClient> extends Promise<infer C> ? C : never;
  applyStore: ApplyStore;
  from: string;
  to: string;
  compareFrom: string | null;
  compareTo: string | null;
}) {
  const comparing = Boolean(compareFrom && compareTo);
  const compareWeeklyStart = new Date(compareFrom ?? from);
  compareWeeklyStart.setDate(compareWeeklyStart.getDate() - 7);
  const weeklyStart = new Date(from);
  weeklyStart.setDate(weeklyStart.getDate() - 7);

  // Only the weekly rows are still fetched here. The daily/monthly/agent
  // queries this section used to run fed the period and agent-wise tables,
  // which are now self-contained sections with their own scope and their own
  // queries — leaving those fetches in place would have run four page-scoped
  // queries per load whose results nothing rendered.
  const [{ data: weeks }, { data: compareWeeks }] = await timeAll("sales:ebo_detail", [
    applyStore(
      supabase.schema("sales").from<WeeklyRow>("vw_ebo_sales_weekly").select("*").gte("week_start", isoDate(weeklyStart)).lte("week_start", to)
    ) as unknown as QueryChain<WeeklyRow>,
    comparing
      ? (applyStore(
          supabase.schema("sales").from<WeeklyRow>("vw_ebo_sales_weekly").select("*").gte("week_start", isoDate(compareWeeklyStart)).lte("week_start", compareTo as string)
        ) as unknown as QueryChain<WeeklyRow>)
      : Promise.resolve({ data: [] as WeeklyRow[] }),
  ] as const);

  const totals = computeSalesTotals(weeks, from);
  // Same helper, second window — the comparison numbers come from the exact
  // function that produces the current ones, never a parallel formula.
  const compareTotals = comparing ? computeSalesTotals(compareWeeks, compareFrom as string) : null;

  return (
    <>
      {compareTotals && (
        // Rendered ONLY while a comparison is active — with comparison off
        // this section is exactly what it was before Phase 4, no new
        // always-on KPI row appearing on a page nobody asked to change.
        // Weekly grain (same rows the league and period table already use),
        // so the window is whole retail weeks touching the range, not the
        // raw day boundaries — stated on screen rather than left to guess.
        <div className="mb-6">
          <p className="mb-2 text-[11.5px] text-ink-3">
            EBO totals vs {compareFrom} – {compareTo} (retail weeks touching each range)
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <KpiCard
              label="Net sales"
              value={INR(totals.totalNetSales)}
              delta={<DeltaBadge current={totals.totalNetSales} previous={compareTotals.totalNetSales} baselineLabel={`vs ${INR(compareTotals.totalNetSales)}`} />}
            />
            <KpiCard
              label="Sale bills"
              value={totals.totalSaleBills.toLocaleString("en-IN")}
              delta={<DeltaBadge current={totals.totalSaleBills} previous={compareTotals.totalSaleBills} baselineLabel={`vs ${compareTotals.totalSaleBills.toLocaleString("en-IN")}`} />}
            />
            <KpiCard
              label="Units"
              value={totals.totalSaleQty.toLocaleString("en-IN")}
              delta={<DeltaBadge current={totals.totalSaleQty} previous={compareTotals.totalSaleQty} baselineLabel={`vs ${compareTotals.totalSaleQty.toLocaleString("en-IN")}`} />}
            />
            <KpiCard
              label="ATV"
              value={totals.networkAtv !== null ? INR(totals.networkAtv) : "—"}
              delta={<DeltaBadge current={totals.networkAtv} previous={compareTotals.networkAtv} baselineLabel={compareTotals.networkAtv !== null ? `vs ${INR(compareTotals.networkAtv)}` : "vs —"} />}
            />
            <KpiCard
              label="UPT"
              value={totals.networkUpt !== null ? totals.networkUpt.toFixed(2) : "—"}
              delta={<DeltaBadge current={totals.networkUpt} previous={compareTotals.networkUpt} baselineLabel={compareTotals.networkUpt !== null ? `vs ${compareTotals.networkUpt.toFixed(2)}` : "vs —"} />}
            />
            <KpiCard
              label="Discount %"
              value={totals.discountPct !== null ? `${totals.discountPct.toFixed(1)}%` : "—"}
              delta={
                <DeltaBadge
                  current={totals.discountPct}
                  previous={compareTotals.discountPct}
                  mode="pp"
                  invert
                  baselineLabel={compareTotals.discountPct !== null ? `vs ${compareTotals.discountPct.toFixed(1)}%` : "vs —"}
                />
              }
            />
          </div>
        </div>
      )}

      {/* The period table and the agent-wise table used to render here. Both
          moved out to their own self-contained sections (PeriodTableSection /
          AgentTableSection), each with its own Location, Period, comparison
          period and attribute filter and its own query — they no longer share
          this section's single page-scoped fetch. What is left here is the
          page-level comparison strip above.

          Hour of day, Store league and Scheme penetration used to render here.
          They moved into EboAttributeBlockSection (above the period table) so
          all three could be driven by one shared product-attribute filter and
          one shared comparison period — impossible while they read the
          pre-aggregated hourly/weekly/scheme rollups, none of which carry a
          product attribute. Their arithmetic is unchanged; see
          lib/sales/lineAggregates.ts. */}
    </>
  );
}

/**
 * Fetches every sale LINE for a date window under the caller's store scope.
 *
 * Paged via fetchAllRows because this is line grain and PostgREST's project
 * "Max Rows" caps every response at 1000 with no error — the failure mode that
 * made a WIDER date range report LOWER sales. The .order() calls are
 * load-bearing, not decoration: .range() paging is only a correct partition of
 * the view if the server-side ordering is stable across the separate REST
 * calls. Same discipline as ProductAttributeSection's own fetch.
 */
function fetchSaleLines(
  supabase: ReturnType<typeof createClient> extends Promise<infer C> ? C : never,
  applyStore: ApplyStore,
  from: string,
  to: string
) {
  return fetchAllRows<SaleLineRow>(() =>
    applyStore(
      supabase
        .schema("sales")
        .from<SaleLineRow>("vw_ebo_sale_attribute_lines")
        .select(SALE_LINE_SELECT)
        .gte("bill_date", from)
        .lte("bill_date", to)
        .order("bill_date", { ascending: true })
        .order("bill_no", { ascending: true })
        .order("item_code", { ascending: true })
    ) as unknown as QueryChain<SaleLineRow>
  );
}

/**
 * THE SHARED ATTRIBUTE BLOCK — Net sales by day, Hour of day, Store league and
 * Scheme penetration, all four narrowed by ONE attribute filter and all four
 * carrying the comparison period.
 *
 * WHY THESE FOUR MOVED HERE. Each used to read a different pre-aggregated
 * rollup (vw_ebo_sales_hourly, vw_ebo_sales_weekly, vw_ebo_scheme_daily), and
 * not one of those rollups carries a product attribute — so "net sales by hour
 * for DRESSES" was unanswerable, whichever way the UI was arranged. Reading
 * all four off the line-grain view instead is what makes one shared attribute
 * filter possible at all. lib/sales/lineAggregates.ts reproduces each rollup's
 * exact arithmetic so the numbers do not move just because the source did.
 *
 * ONE FETCH, TWO USES. The lines are fetched UNFILTERED for the window and the
 * attribute filter is applied in memory. That is deliberate: the filter bar's
 * cascading option counts must be computed over the rows that DON'T pass the
 * filter as well as those that do (see FacetFilterBar's rowsExcludingFacet),
 * so narrowing at the database would throw away exactly what the control needs
 * to stay usable. It also means changing a filter re-renders from one fetch
 * per window rather than issuing a new query per facet click.
 *
 * SCOPE IS SCOPED TO THIS BLOCK. Location, Period, Compare and Attributes are
 * all this block's own (2026-09-05, item 3) — it used to take the PAGE-level
 * dates and store selection as props and own only the attribute bar. The
 * period table, agent-wise, product-attribute and footfall sections below each
 * own their own and are unaffected by this one. ONE TableScopeBar drives all
 * four sub-displays, deliberately: they are read as one block, and forking the
 * bar per sub-display was explicitly not the merged design.
 */
async function EboAttributeBlockSection({
  supabase,
  scope,
  storeNames,
  storeOptions,
  paramPrefix,
}: {
  supabase: ReturnType<typeof createClient> extends Promise<infer C> ? C : never;
  scope: ReturnType<typeof resolveTableScope>;
  storeNames: Map<string, string>;
  storeOptions: string[];
  paramPrefix: string;
}) {
  const { from, to, compareFrom, compareTo, comparing, selection } = scope;
  const applyStore = applyStoreFor(scope.storeFilters);

  const [lines, compareLines] = await timeAll("sales:ebo_attribute_block", [
    fetchSaleLines(supabase, applyStore, from, to),
    comparing
      ? fetchSaleLines(supabase, applyStore, compareFrom as string, compareTo as string)
      : Promise.resolve([] as SaleLineRow[]),
  ] as const);

  const allLines = lines ?? [];
  // Options/counts come from the UNFILTERED lines — see this component's
  // header. The figures below come from the filtered ones.
  const options = buildAttributeOptions(allLines, selection);
  const filtered = applyAttributeFilter(allLines, selection);
  const filteredCompare = applyAttributeFilter(compareLines ?? [], selection);

  const trend = computeTrendFromLines(filtered);
  const compareTrend = comparing ? computeTrendFromLines(filteredCompare) : null;
  const hourly = computeHourlyFromLines(filtered);
  const compareHourly = comparing ? computeHourlyFromLines(filteredCompare) : null;
  const league = computeLeagueFromLines(filtered, storeNames);
  const compareLeague = comparing ? computeLeagueFromLines(filteredCompare, storeNames) : null;
  const { schemeRows, schemeMaxQty } = computeSchemeFromLines(filtered);
  const compareScheme = comparing ? computeSchemeFromLines(filteredCompare).schemeRows : null;

  const activeAttrs = describeAttributeSelection(selection);
  const filteredOut = allLines.length - filtered.length;

  return (
    <>
      {/* ONE bar for all four sub-displays — Location, Period, Compare and the
          eight attribute facets, all in this block's own param namespace. */}
      <TableScopeBar
        paramPrefix={paramPrefix}
        from={from}
        to={to}
        compareFrom={compareFrom}
        compareTo={compareTo}
        storeOptions={storeOptions}
        storeLabels={Object.fromEntries(storeNames)}
        storeFilters={scope.storeFilters}
        selection={selection}
        options={options}
        overridden={scope.overridden}
      />

      {/* States what the filter actually did, as a fact on screen rather than
          something to infer from the bar — same "Showing:" convention the
          page header uses for its own scope. */}
      {!isAttributeSelectionEmpty(selection) && (
        <p className="mt-1.5 text-[11.5px] text-ink-2">
          Attribute filter: {activeAttrs} · {filtered.length.toLocaleString("en-IN")} of{" "}
          {allLines.length.toLocaleString("en-IN")} lines ({filteredOut.toLocaleString("en-IN")} excluded)
        </p>
      )}

      <SectionCard
        icon={<TrendingUp className="h-4 w-4" />}
        title="Net sales by day — EBO"
        subtitle="EBO lines only, narrowed by the attribute filter above. The cross-vertical trend at the top of the page is unfiltered and includes every vertical in scope."
        className="mt-3"
      >
        {trend.length === 0 && (!compareTrend || compareTrend.length === 0) ? (
          <p className="py-10 text-center text-sm text-ink-3">No EBO sales match this filter in this window.</p>
        ) : compareTrend ? (
          <ComparisonTrendChart
            current={trend}
            comparison={compareTrend}
            from={from}
            to={to}
            compareFrom={compareFrom as string}
            compareTo={compareTo as string}
            ariaLabel="Daily net sales for EBO under the current attribute filter, current period against the comparison period"
          />
        ) : (
          <TrendChart points={trend} ariaLabel="Daily net sales for EBO under the current attribute filter" />
        )}
      </SectionCard>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SectionCard icon={<Clock className="h-4 w-4" />} title="Net sales by hour of day — EBO">
          <HourlyWithComparison
            points={hourly}
            comparePoints={compareHourly}
            ariaLabel="Net sales by hour of day, EBO, under the current attribute filter"
          />
        </SectionCard>

        <SectionCard icon={<Trophy className="h-4 w-4" />} title="Store league — EBO" subtitle="Click a row for that store's own daily trend.">
          <StoreLeagueFacetedContent league={league} from={from} to={to} />
          {compareLeague && <StoreLeagueComparison current={league} comparison={compareLeague} />}
        </SectionCard>
      </div>

      <SectionCard icon={<Tag className="h-4 w-4" />} title="Scheme penetration (by units sold) — EBO" className="mt-6">
        <div className="border border-line-soft p-3">
          <SchemePenetrationBars rows={schemeRows} maxQty={schemeMaxQty} compareRows={compareScheme} />
        </div>
      </SectionCard>
    </>
  );
}

/**
 * Shared plumbing for the three self-contained tables: fetch this table's own
 * line set, build its filter options from the unfiltered rows, and hand back
 * both the filtered current and comparison sets.
 *
 * Each table issuing its OWN query is the point, not an oversight — that is
 * what "independent Location/Period/Compare per table" means. The queries are
 * the same cheap line-grain read the block above already does, each paged via
 * fetchAllRows and each store-scoped through its own applyStore.
 */
async function loadTableLines(
  supabase: ReturnType<typeof createClient> extends Promise<infer C> ? C : never,
  scope: ReturnType<typeof resolveTableScope>,
  label: string
) {
  const applyStore = applyStoreFor(scope.storeFilters);
  const [lines, compareLines] = await timeAll(label, [
    fetchSaleLines(supabase, applyStore, scope.from, scope.to),
    scope.comparing
      ? fetchSaleLines(supabase, applyStore, scope.compareFrom as string, scope.compareTo as string)
      : Promise.resolve([] as SaleLineRow[]),
  ] as const);

  const all = lines ?? [];
  return {
    options: buildAttributeOptions(all, scope.selection),
    filtered: applyAttributeFilter(all, scope.selection),
    filteredCompare: applyAttributeFilter(compareLines ?? [], scope.selection),
    totalLines: all.length,
  };
}

/** Stores that actually have activity in a line set — the axis the table's rows are built over. */
const storesInLines = (lines: SaleLineRow[]) =>
  [...new Set(lines.map((l) => l.store_id).filter((s): s is string => Boolean(s)))].sort();

/** Inclusive day count of a range — what the trend table's opening grain is chosen from. */
const rangeDays = (from: string, to: string) =>
  Math.max(1, Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400000) + 1);

/**
 * "Sales trend by period — EBO" (2026-09-05, item 1, first half of the old
 * PeriodTableSection): consecutive periods within ONE range, with the
 * period-over-period change between ADJACENT ROWS. Own Location, Period and
 * attribute filter, its own query.
 *
 * NO COMPARISON RANGE, deliberately — this is the fix, not an omission. The
 * old single table carried both readings at once: rows bucketed by calendar
 * period with a row-to-row "Net change %", AND a range-vs-range compare strip.
 * Reading a full month's row against a 4-day partial month's row produced the
 * reported "-94.4%", which is arithmetically correct and answers a question
 * nobody asked. Range-vs-range moved to "Period comparison" below, which has
 * no calendar buckets at all, so the two readings can no longer be confused.
 *
 * The four grain builders in lib/sales/aggregate.ts are reused UNCHANGED —
 * lib/sales/lineRollups.ts folds the filtered lines back into the exact row
 * shapes the daily/weekly/monthly views emit, so the period labels,
 * prior-period change %, complete-vs-partial flags and network-total bucket
 * all keep their existing behaviour rather than being re-derived against a new
 * source. Every feature of PeriodSalesFacetedTable (facets, group-by, saved
 * views, sort, subtotal footers) is untouched: only where its rows come from
 * has changed.
 */
async function TrendTableSection({
  supabase,
  scope: rawScope,
  storeNames,
  storeOptions,
  today,
}: {
  supabase: ReturnType<typeof createClient> extends Promise<infer C> ? C : never;
  scope: ReturnType<typeof resolveTableScope>;
  storeNames: Map<string, string>;
  storeOptions: string[];
  today: Date;
}) {
  // Comparison is forced off for this table, including the inherited
  // page-level one — otherwise a page-level compare range would silently
  // re-introduce the second reading this split exists to remove, and would
  // also cost a second line-grain fetch nothing renders.
  const scope = { ...rawScope, compareFrom: null, compareTo: null, comparing: false };
  const { options, filtered } = await loadTableLines(supabase, scope, "sales:trend_table");

  const todayStr = isoDate(today);
  const todayMonthStart = todayStr.slice(0, 7) + "-01";

  const buildFor = (lines: SaleLineRow[]) => {
    const daily = linesToDailyRows(lines);
    const weekly = linesToWeeklyRows(lines, todayStr);
    const monthly = linesToMonthlyRows(lines);
    const stores = storesInLines(lines);
    const latestFy = [...monthly].sort((a, b) => (b.month_start ?? "").localeCompare(a.month_start ?? ""))[0]?.financial_year ?? "";

    // Same per-store + "Network total" shape EboDetailSection's own buildRows
    // produced — the network bucket is just another store-like row, added only
    // when there is more than one store to total.
    const build = <T extends { periodKey: string }>(builder: (storeId: string | null) => T[]) => {
      const perStore = stores.flatMap((sid) => builder(sid).map((r) => ({ ...r, storeId: sid, storeName: storeNames.get(sid) ?? sid })));
      if (stores.length > 1) {
        perStore.push(...builder(null).map((r) => ({ ...r, storeId: "__network__", storeName: "Network total" })));
      }
      return perStore;
    };

    return {
      daily: build((sid) => buildDailyPeriodSeries(daily, sid, todayStr)) as PeriodFacetedRow[],
      weekly: build((sid) =>
        buildWeekSeries(weekly, sid).map((w) => ({
          periodKey: w.weekStart,
          periodLabel: `RW${String(w.retailWeek).padStart(2, "0")}`,
          rangeLabel: `${weekDayLabel(w.weekStart)} – ${weekDayLabel(addDaysIso(w.weekStart, 6))}`,
          net: w.net,
          gross: w.gross,
          discount: w.discount,
          discountPct: w.gross > 0 ? (w.discount / w.gross) * 100 : null,
          bills: w.bills,
          qty: w.qty,
          freshQty: w.freshQty,
          eossQty: w.eossQty,
          atv: w.bills > 0 ? w.net / w.bills : null,
          netChangePct: w.netChangePct,
          qtyChangePct: w.qtyChangePct,
          isComplete: w.isCompleteWeek,
        }))
      ) as PeriodFacetedRow[],
      monthly: build((sid) => buildMonthlyPeriodSeries(monthly, sid, todayMonthStart)) as PeriodFacetedRow[],
      yearly: build((sid) => buildYearlyPeriodSeries(monthly, sid, latestFy)) as PeriodFacetedRow[],
    };
  };

  const cur = buildFor(filtered);

  return (
    <SectionCard
      icon={<CalendarRange className="h-4 w-4" />}
      title="Sales trend by period — EBO"
      subtitle="Consecutive periods inside ONE range. The change column compares each row with the row above it (DoD / WoW / MoM / YoY) — for a range-vs-range comparison use the Period comparison table below."
    >
      <TableScopeBar
        paramPrefix={TREND_TABLE_PREFIX}
        from={scope.from}
        to={scope.to}
        compareFrom={null}
        compareTo={null}
        storeOptions={storeOptions}
        storeLabels={Object.fromEntries(storeNames)}
        storeFilters={scope.storeFilters}
        selection={scope.selection}
        options={options}
        overridden={scope.overridden}
        showCompare={false}
      />
      <PeriodSalesFacetedTable
        daily={cur.daily}
        weekly={cur.weekly}
        monthly={cur.monthly}
        yearly={cur.yearly}
        pageKey="sales_trend"
        defaultGrain={grainForRange(rangeDays(scope.from, scope.to))}
        // These rows came from LINE grain (lineRollups), so each line was
        // classified Fresh/EOSS before it was summed — the split is real here.
        showQtySplit
      />
    </SectionCard>
  );
}

/**
 * "Period comparison — EBO" (2026-09-05, item 1, second half): a genuine
 * Current-range vs Compare-range reading, and NOTHING ELSE.
 *
 * No grain toggle and no calendar buckets AT ALL — that is the whole design.
 * A whole-range sum on each side means a full month vs a 4-day month can only
 * ever read as "this range's total vs that range's total", which is what the
 * user actually meant when the old table's adjacent-row change column answered
 * a different question with a confident-looking "-94.4%".
 *
 * BOTH RANGES ARE SCOPED BY THE SAME ATTRIBUTE SELECTION (scope.selection,
 * applied to both line sets by loadTableLines) — a hard requirement, not a
 * nicety: comparing "DRESSES this month" against "everything last month"
 * would be a wrong number with nothing visibly broken.
 *
 * The rows are TableCompareStrip, the same total-vs-total shape the other
 * tables' compare strips already render, rather than a new table component:
 * one total row is the default the brief asked for, and a fifth bespoke
 * rendering of "two totals side by side" would be one more thing to keep in
 * step with DeltaBadge's pp/invert conventions.
 */
async function PeriodComparisonSection({
  supabase,
  scope,
  storeNames,
  storeOptions,
}: {
  supabase: ReturnType<typeof createClient> extends Promise<infer C> ? C : never;
  scope: ReturnType<typeof resolveTableScope>;
  storeNames: Map<string, string>;
  storeOptions: string[];
}) {
  const { options, filtered, filteredCompare } = await loadTableLines(supabase, scope, "sales:period_comparison");
  const curTotals = computeTotalsFromLines(filtered);
  const curSplit = computeQtySplitFromLines(filtered);
  const cmpTotals = scope.comparing ? computeTotalsFromLines(filteredCompare) : null;
  const cmpSplit = scope.comparing ? computeQtySplitFromLines(filteredCompare) : null;

  return (
    <SectionCard
      icon={<CalendarRange className="h-4 w-4" />}
      title="Period comparison — EBO"
      subtitle="Whole-range total vs whole-range total. Never bucketed by calendar period, so a full month and a part month compare as the two totals they are."
      className="mt-6"
    >
      <TableScopeBar
        paramPrefix={COMPARE_TABLE_PREFIX}
        from={scope.from}
        to={scope.to}
        compareFrom={scope.compareFrom}
        compareTo={scope.compareTo}
        storeOptions={storeOptions}
        storeLabels={Object.fromEntries(storeNames)}
        storeFilters={scope.storeFilters}
        selection={scope.selection}
        options={options}
        overridden={scope.overridden}
        compareHint="Both ranges are narrowed by the SAME attribute filter above, so the comparison stays like-for-like."
      />
      {cmpTotals && cmpSplit ? (
        <>
          <TableCompareStrip
            current={curTotals}
            comparison={cmpTotals}
            compareFrom={scope.compareFrom as string}
            compareTo={scope.compareTo as string}
          />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <KpiCard
              label="Fresh qty"
              value={curSplit.freshQty.toLocaleString("en-IN")}
              delta={<DeltaBadge current={curSplit.freshQty} previous={cmpSplit.freshQty} baselineLabel={`vs ${cmpSplit.freshQty.toLocaleString("en-IN")}`} />}
            />
            <KpiCard
              label="EOSS qty"
              value={curSplit.eossQty.toLocaleString("en-IN")}
              delta={<DeltaBadge current={curSplit.eossQty} previous={cmpSplit.eossQty} baselineLabel={`vs ${cmpSplit.eossQty.toLocaleString("en-IN")}`} />}
            />
            <KpiCard
              label="Total qty"
              value={curSplit.totalQty.toLocaleString("en-IN")}
              delta={<DeltaBadge current={curSplit.totalQty} previous={cmpSplit.totalQty} baselineLabel={`vs ${cmpSplit.totalQty.toLocaleString("en-IN")}`} />}
              sub="Fresh + EOSS"
            />
          </div>
        </>
      ) : (
        <p className="border border-line-soft bg-surface-2 px-3 py-6 text-center text-[12.5px] text-ink-3">
          Set a <strong>Compare</strong> range above (Previous period, Previous year, or any custom range) to see this
          range&apos;s totals against it.
        </p>
      )}
    </SectionCard>
  );
}

/**
 * "Agent-wise sales — EBO", self-contained. Reproduces vw_ebo_agent_daily's
 * own aggregation over lines (see computeAgentRowsFromLines) so the table can
 * be narrowed by product attribute — impossible against that rollup, which
 * carries none. AgentSalesFacetedTable itself is unchanged.
 */
async function AgentTableSection({
  supabase,
  scope,
  storeNames,
  storeOptions,
}: {
  supabase: ReturnType<typeof createClient> extends Promise<infer C> ? C : never;
  scope: ReturnType<typeof resolveTableScope>;
  storeNames: Map<string, string>;
  storeOptions: string[];
}) {
  const { options, filtered, filteredCompare } = await loadTableLines(supabase, scope, "sales:agent_table");
  const agentRows = computeAgentRowsFromLines(filtered);
  const cmp = scope.comparing ? computeTotalsFromLines(filteredCompare) : null;

  return (
    <SectionCard icon={<Users className="h-4 w-4" />} title="Agent-wise sales — EBO" className="mt-6">
      <TableScopeBar
        paramPrefix={AGENT_TABLE_PREFIX}
        from={scope.from}
        to={scope.to}
        compareFrom={scope.compareFrom}
        compareTo={scope.compareTo}
        storeOptions={storeOptions}
        storeLabels={Object.fromEntries(storeNames)}
        storeFilters={scope.storeFilters}
        selection={scope.selection}
        options={options}
        overridden={scope.overridden}
      />
      {cmp && (
        <TableCompareStrip
          current={computeTotalsFromLines(filtered)}
          comparison={cmp}
          compareFrom={scope.compareFrom as string}
          compareTo={scope.compareTo as string}
        />
      )}
      <AgentSalesFacetedTable rows={agentRows} storeNames={Object.fromEntries(storeNames)} />
    </SectionCard>
  );
}

/**
 * Totals strip shown above a self-contained table while ITS OWN comparison is
 * active. Recomputed from summed parts for both windows by the same function
 * (computeTotalsFromLines), never a second parallel formula — the rule
 * rollUpCore and computeSalesTotals already follow for the page-level strips.
 */
function TableCompareStrip({
  current,
  comparison,
  compareFrom,
  compareTo,
}: {
  current: ReturnType<typeof computeTotalsFromLines>;
  comparison: ReturnType<typeof computeTotalsFromLines>;
  compareFrom: string;
  compareTo: string;
}) {
  return (
    <div className="mb-3">
      <p className="mb-2 text-[11.5px] text-ink-3">
        This table only — vs {compareFrom} – {compareTo}
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard
          label="Net sales"
          value={INR(current.net)}
          delta={<DeltaBadge current={current.net} previous={comparison.net} baselineLabel={`vs ${INR(comparison.net)}`} />}
        />
        <KpiCard
          label="Sale bills"
          value={current.bills.toLocaleString("en-IN")}
          delta={<DeltaBadge current={current.bills} previous={comparison.bills} baselineLabel={`vs ${comparison.bills.toLocaleString("en-IN")}`} />}
        />
        <KpiCard
          label="Units"
          value={current.qty.toLocaleString("en-IN")}
          delta={<DeltaBadge current={current.qty} previous={comparison.qty} baselineLabel={`vs ${comparison.qty.toLocaleString("en-IN")}`} />}
        />
        <KpiCard
          label="ATV"
          value={current.atv !== null ? INR(current.atv) : "—"}
          delta={<DeltaBadge current={current.atv} previous={comparison.atv} baselineLabel={comparison.atv !== null ? `vs ${INR(comparison.atv)}` : "vs —"} />}
        />
        <KpiCard
          label="Discount %"
          value={current.discountPct !== null ? `${current.discountPct.toFixed(1)}%` : "—"}
          delta={
            <DeltaBadge
              current={current.discountPct}
              previous={comparison.discountPct}
              mode="pp"
              invert
              baselineLabel={comparison.discountPct !== null ? `vs ${comparison.discountPct.toFixed(1)}%` : "vs —"}
            />
          }
        />
      </div>
    </div>
  );
}

function EboAttributeBlockSkeleton() {
  return (
    <>
      <div className="h-10 border border-line-soft bg-surface-2" />
      <div className="mt-3">
        <ChartSkeleton height={160} />
      </div>
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartSkeleton height={220} />
        <TableSkeleton rows={6} cols={7} />
      </div>
      <div className="mt-6">
        <SectionLabelSkeleton />
        <div className="mt-2 h-32 border border-line-soft" />
      </div>
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
 * EBO-only — PRODUCT-attribute breakdown ("how did the SS2026 collection
 * perform"), Phase 3 of the /sales polish plan. Deliberately NOT a calendar
 * grain: it is independent of, and composes with, the Daily/Weekly/Monthly/
 * Yearly toggle EboDetailSection's own PeriodSalesFacetedTable already
 * ships. Same mechanism as Sale vs Stock Mix's "View by" attribute combo,
 * applied to Sale rather than Stock/Mix data.
 *
 * EBO-only by data, not by preference: sales.vw_ecomm_order_lines (0067)
 * carries item_sku/style/size/color/brand off Uniware and has no season,
 * gender, size_group, category or market_segment at all, so the same
 * breakdown genuinely cannot be computed for ECOM today. Gated with the rest
 * of the EBO block rather than rendered empty.
 *
 * Its own Suspense boundary and its own fetch — this is the only LINE-grain
 * query on the page (everything else reads a pre-aggregated rollup view), so
 * it must not be able to hold up the sections that don't need it. Volume is
 * modest at today's scale (a full fiscal year of the real Sale exports is
 * ~4.7k-14.5k lines, so a 30-day default range is low thousands), but it
 * pages via fetchAllRows regardless: Supabase's project "Max Rows" setting
 * silently caps EVERY response at 1000 rows with no error, and a line-grain
 * query is exactly where that bites (see lib/data/client.ts's own note, and
 * the ~95%-of-rows-dropped bug it was found by).
 */
async function ProductAttributeSection({
  supabase,
  scope,
  storeNames,
  storeOptions,
}: {
  supabase: ReturnType<typeof createClient> extends Promise<infer C> ? C : never;
  scope: ReturnType<typeof resolveTableScope>;
  storeNames: Map<string, string>;
  storeOptions: string[];
}) {
  const { options, filtered, filteredCompare } = await loadTableLines(supabase, scope, "sales:product_attribute");
  const cmp = scope.comparing ? computeTotalsFromLines(filteredCompare) : null;

  return (
    <SectionCard
      icon={<Shirt className="h-4 w-4" />}
      title="Sales by product attribute — EBO"
      subtitle="Season + Year by default. Drag chips to combine attributes — e.g. Season + Gender. Bills count every bill containing the attribute, so they overlap across groups and do not sum to the network total; net sales, qty and gross do."
    >
      <TableScopeBar
        paramPrefix={ATTR_TABLE_PREFIX}
        from={scope.from}
        to={scope.to}
        compareFrom={scope.compareFrom}
        compareTo={scope.compareTo}
        storeOptions={storeOptions}
        storeLabels={Object.fromEntries(storeNames)}
        storeFilters={scope.storeFilters}
        selection={scope.selection}
        options={options}
        overridden={scope.overridden}
      />
      {cmp && (
        <TableCompareStrip
          current={computeTotalsFromLines(filtered)}
          comparison={cmp}
          compareFrom={scope.compareFrom as string}
          compareTo={scope.compareTo as string}
        />
      )}
      {/* The attribute FILTER above narrows which lines are in play; the
          attribute COMBO inside the table still chooses how they are grouped.
          They compose — filter to one Category, then break it down by Season +
          Gender — which is why both exist rather than one replacing the other. */}
      <ProductAttributeSalesTable lines={filtered as SaleAttributeLineRow[]} />
    </SectionCard>
  );
}

function ProductAttributeSkeleton() {
  return (
    <>
      <SectionLabelSkeleton />
      <TableSkeleton rows={6} cols={7} />
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
  scope,
  storeNames,
  today,
}: {
  supabase: ReturnType<typeof createClient> extends Promise<infer C> ? C : never;
  applyStore: ApplyStore;
  scope: ReturnType<typeof resolveTableScope>;
  storeNames: Map<string, string>;
  today: Date;
}) {
  // This section's OWN period and OWN comparison baseline, independent of the
  // page-level ones — every figure below is a "this window vs that window"
  // comparison, so which two windows they are is the section's main question,
  // not a page-wide setting.
  const from = scope.from;
  const to = scope.to;

  // The baseline was ALWAYS the immediately-preceding window of equal length,
  // computed here with no way to change it. That default is kept exactly (so
  // an untouched section reads as it always did), and is now overridable: when
  // this section's own Compare is set, those dates become the baseline instead.
  const periodDays = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1;
  const autoPrevTo = new Date(from);
  autoPrevTo.setDate(autoPrevTo.getDate() - 1);
  const autoPrevFrom = new Date(autoPrevTo);
  autoPrevFrom.setDate(autoPrevFrom.getDate() - (periodDays - 1));
  const prevFrom = scope.comparing ? new Date(scope.compareFrom as string) : autoPrevFrom;
  const prevTo = scope.comparing ? new Date(scope.compareTo as string) : autoPrevTo;
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
      <TableScopeBar
        paramPrefix={FOOTFALL_PREFIX}
        from={from}
        to={to}
        compareFrom={scope.compareFrom}
        compareTo={scope.compareTo}
        overridden={scope.overridden}
        showAttributes={false}
        showLocation={false}
        compareHint={
          scope.comparing
            ? undefined
            : `Baseline defaults to the preceding ${periodDays} days (${isoDate(autoPrevFrom)} – ${isoDate(autoPrevTo)}). Set Compare to choose another.`
        }
      />

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
  // Every query here goes through fetchAllRows(): PostgREST caps a bare
  // response at 1000 rows with no error, and ecomm rows are per-order-LINE, so
  // that cap is reached in days rather than months — "Top styles", the channel
  // table and the returns breakdown were all reporting an arbitrary 1000-row
  // subset of the chosen window. fetchAllRows needs a FRESH builder per page
  // (a query builder is single-use once ranged), hence the factory closures;
  // and each carries an explicit stable .order() because .range() paging is
  // only a correct partition if the row order is stable across REST calls —
  // the line query previously had no .order() at all, so which 1000 rows
  // survived was not even reproducible between reloads.
  const buildLinesQuery = () => {
    let q = applyChannel(
      supabase
        .schema("sales")
        .from<EcommLineRow>("vw_ecomm_order_lines")
        .select("channel, item_sku, style, status, selling_price, mrp, discount")
        .gte("order_date", from)
        .lte("order_date", to)
    ) as unknown as QueryChain<EcommLineRow>;
    if (channel) q = q.eq("channel", channel) as unknown as QueryChain<EcommLineRow>;
    return q.order("order_date", { ascending: true }).order("channel", { ascending: true }).order("item_sku", { ascending: true });
  };

  const [dailyRows, lineRows, returnRows] = await timeAll("sales:ecomm_detail", [
    fetchAllRows<EcommDailyRow>(
      () =>
        applyChannel(
          supabase.schema("sales").from<EcommDailyRow>("vw_ecomm_daily").select("*").gte("order_date", from).lte("order_date", to)
        ).order("order_date", { ascending: true }).order("channel", { ascending: true }) as unknown as QueryChain<EcommDailyRow>
    ),
    fetchAllRows<EcommLineRow>(buildLinesQuery),
    fetchAllRows<EcommReturnRow>(
      () =>
        applyChannel(
          supabase.schema("sales").from<EcommReturnRow>("vw_ecomm_returns").select("reverse_pickup_code, status, return_date").gte("return_date", from).lte("return_date", to)
        ).order("return_date", { ascending: true }).order("reverse_pickup_code", { ascending: true }) as unknown as QueryChain<EcommReturnRow>
    ),
  ] as const);

  const daily = dailyRows ?? [];
  const lines = lineRows ?? [];
  const returns = returnRows ?? [];

  const byChannel = new Map<string, { orders: number; cancelled: number; units: number; net: number; mrp: number; discount: number }>();
  for (const r of daily) {
    const c = byChannel.get(r.channel) ?? { orders: 0, cancelled: 0, units: 0, net: 0, mrp: 0, discount: 0 };
    c.orders += Number(r.total_orders);
    c.cancelled += Number(r.cancelled_orders ?? 0);
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
        <EcommChannelFacetedTable rows={ecommChannelRows} activeChannel={channel} />
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
          {/* topSkuRows is .slice(0, 20) — this totals the styles SHOWN, which
              is why the label says so rather than "Total". */}
          {topSkuRows.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-line bg-surface-2 font-bold">
                <td className="px-3 py-2">Total — top {topSkuRows.length} styles</td>
                <td className="px-3 py-2 text-right font-mono">{topSkuRows.reduce((s, r) => s + r.units, 0)}</td>
                <td className="px-3 py-2 text-right font-mono">{INR(topSkuRows.reduce((s, r) => s + r.net, 0))}</td>
              </tr>
            </tfoot>
          )}
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
          {/* Statuses partition the returns, so this is the full return count. */}
          {returnStatusRows.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-line bg-surface-2 font-bold">
                <td className="px-3 py-2">Total</td>
                <td className="px-3 py-2 text-right font-mono">{returnStatusRows.reduce((s, [, c]) => s + c, 0)}</td>
              </tr>
            </tfoot>
          )}
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
  // The index signature carries the PREFIXED params the four AttributeFilterBar
  // instances and the three self-contained tables write (attr_cat,
  // periodTable_from, ...). They are read through helpers keyed by prefix
  // rather than declared one by one — eight facets x four instances plus each
  // table's own scope controls is far past the point where naming every param
  // in this type would help a reader.
  searchParams: {
    from?: string;
    to?: string;
    compareFrom?: string;
    compareTo?: string;
    store?: string;
    bu?: string;
    channel?: string;
    channels?: string;
  } & Record<string, string | string[] | undefined>;
}) {
  // requirePageAccess (not the plain requireRole this used before
  // 2026-08-28) so a per-user override on the "sales" page key actually
  // applies — requireRole only ever checked the hardcoded role list, so an
  // admin granting/denying "Sales" access for one user in the Users page had
  // no effect here. PAGE_BUSINESS_UNIT.sales is ["retail","ecomm"] (an
  // array, not a single value) specifically so this outer gate can't lock
  // out an ecomm-only user — the real per-vertical narrowing stays exactly
  // where it already was, in resolveViewScope.granted below, not here.
  const user = await requirePageAccess("sales");
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

  // Period comparison (Phase 4, 2026-08-26) — OFF by default, and only
  // active when BOTH ends are present. Half a range is treated as no range
  // at all rather than silently completing it, so a hand-edited URL can
  // never produce a delta against a window the user didn't ask for.
  const compareFrom = searchParams.compareFrom && searchParams.compareTo ? searchParams.compareFrom : null;
  const compareTo = searchParams.compareFrom && searchParams.compareTo ? searchParams.compareTo : null;
  const comparing = Boolean(compareFrom && compareTo);

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
    // searchParams.from/to, NOT the resolved `from`/`to`. The resolved pair
    // always has a value (it falls back to a rolling last-30-days default), so
    // writing it here froze that window into the URL: a page opened with no
    // date params, then drilled into a channel, came back with an absolute
    // ?from=&to= that stayed put forever once bookmarked or shared. Matches
    // the three pre-existing-param-only lines above.
    if (searchParams.from) params.set("from", searchParams.from);
    if (searchParams.to) params.set("to", searchParams.to);
    if (compareFrom && compareTo) {
      params.set("compareFrom", compareFrom);
      params.set("compareTo", compareTo);
    }
    if (target) params.set("channel", target);
    const qs = params.toString();
    return qs ? `/sales?${qs}` : "/sales";
  }

  // Store picker only makes sense while EBO is in scope — ecomm has no store
  // axis at all (see queryPlanner.ts's VIEW_STORE_COLUMN null entries for
  // vw_ecomm_*), so showing it while only ECOM is selected would offer a
  // control that narrows nothing.
  const { data: stores } = showEbo
    ? await supabase.schema("core").from<StoreRow>("stores").select("store_id, store_name, is_active").order("store_id")
    : { data: [] as StoreRow[] };

  // Channel picker — mirror-opposite of the store picker: only fetched
  // while ECOM is in scope. Small, cacheable distinct list (a handful of
  // marketplace names), deduped client-side rather than reaching for a
  // dedicated distinct-value RPC for such a small result set.
  const { data: channelRowsRaw } = showEcomm
    ? await supabase.schema("sales").from<{ channel: string }>("vw_ecomm_daily").select("channel").order("channel")
    : { data: [] as { channel: string }[] };
  const allChannels = [...new Set((channelRowsRaw ?? []).map((r) => r.channel).filter(Boolean))];
  // Single source of truth for store exclusion is core.stores.is_active —
  // see 0091_bo002_bo004_stores.sql.
  //
  // ownStores(): core.stores has no RLS (lib/scope/ownStores.ts), so this
  // fed the store picker below the company's entire branch roster. The
  // FIGURES on this page were never affected — every query above reads the
  // sales.vw_ebo_*/ops.vw_ebo_* chain, whose scoping predicate
  // (store_id = any(core.fn_user_store_ids()), rooted in
  // sales.vw_ebo_sales_lines) applyStore() can only narrow further, never
  // widen. This narrows the CONTROL to match the data, so "all stores" in
  // the scope summary means "all stores you hold" in the picker too.
  const activeStores = ownStores(stores, user.storeIds).filter((s) => s.is_active);
  const storeNames = new Map(activeStores.map((s) => [s.store_id, s.store_name]));
  const storeOptionIds = activeStores.map((s) => s.store_id);

  // What an untouched per-table control inherits — see resolveTableScope. A
  // table only stops tracking this the moment its own param appears.
  const pageScope = { from, to, compareFrom, compareTo, storeFilters };

  // Plain-language restatement of the active scope — "which numbers am I
  // looking at" as a fact on screen, not a guess from the filter bar alone
  // (2026-08-26 layout recommendation, Pankaj).
  const activeVerticalLabels = verticals.filter((v) => activeVerticals.includes(v.key)).map((v) => v.label);
  const scopeSummary = [
    activeVerticalLabels.length > 0 ? activeVerticalLabels.join(" + ") : "No vertical selected",
    `${from} to ${to}`,
    showEbo ? (storeFilters.length > 0 ? `${storeFilters.length} store${storeFilters.length > 1 ? "s" : ""}` : "all stores") : null,
    showEcomm ? (channelFilters.length > 0 ? `${channelFilters.length} channel${channelFilters.length > 1 ? "s" : ""}` : "all channels") : null,
    comparing ? `compared to ${compareFrom} to ${compareTo}` : null,
  ].filter(Boolean).join(" · ");

  return (
    <main className="py-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-serif text-2xl">Sales</h1>
        <Link href="/sales/stock-status" className="text-[12.5px] text-accent hover:underline">
          Stock Status (WH vs Shopify) →
        </Link>
      </div>
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
          compareFrom={compareFrom}
          compareTo={compareTo}
          showComparison
          locationSlot={
            // BOTH pickers when both verticals are in scope, not either/or.
            // This was a ternary with showEbo first, so the common default
            // (no ?bu= ⇒ every granted vertical active) rendered only the
            // store picker — while any ?channels= already in the URL kept
            // narrowing every ECOM query, with no control left in the UI to
            // clear it. Each picker is still shown only for a vertical that
            // is actually in scope: store has no meaning for ecomm (see
            // queryPlanner.ts's null VIEW_STORE_COLUMN for vw_ecomm_*).
            showEbo || showEcomm ? (
              <div className="flex flex-wrap items-center gap-2">
                {showEbo && (
                  <MultiSelectFilter
                    paramName="store"
                    options={activeStores.map((s) => s.store_id)}
                    labels={Object.fromEntries(activeStores.map((s) => [s.store_id, s.store_name]))}
                    selected={storeFilters}
                    allLabel="All stores"
                  />
                )}
                {showEcomm && (
                  <MultiSelectFilter
                    paramName="channels"
                    options={allChannels}
                    selected={channelFilters}
                    allLabel="All channels"
                  />
                )}
              </div>
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
              compareFrom={compareFrom}
              compareTo={compareTo}
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

          {/* The shared attribute block renders FIRST inside the EBO section —
              i.e. immediately after the page's cross-vertical "Net sales by
              day" trend — so the four displays that share one attribute filter
              and one comparison period sit together, above the three
              self-contained tables that each own their filters. */}
          <SectionErrorBoundary label="EBO attribute block">
            <Suspense fallback={<EboAttributeBlockSkeleton />}>
              <div className="mt-4">
                <EboAttributeBlockSection
                  supabase={supabase}
                  scope={resolveTableScope(searchParams, SHARED_BLOCK_PREFIX, pageScope)}
                  storeNames={storeNames}
                  storeOptions={storeOptionIds}
                  paramPrefix={SHARED_BLOCK_PREFIX}
                />
              </div>
            </Suspense>
          </SectionErrorBoundary>

          <SectionErrorBoundary label="EBO detail">
            <Suspense fallback={<EboDetailSkeleton />}>
              <div className="mt-8">
                <EboDetailSection
                  supabase={supabase}
                  applyStore={applyStore}
                  from={from}
                  to={to}
                  compareFrom={compareFrom}
                  compareTo={compareTo}
                />
              </div>
            </Suspense>
          </SectionErrorBoundary>

          {/* The three self-contained tables. Each owns its Location, Period,
              comparison period and attribute filter (own URL prefix), runs its
              own query, and streams in its own Suspense boundary — so one
              table's wide date range cannot hold up the others. An untouched
              table still follows the page scope; see resolveTableScope. */}
          <SectionErrorBoundary label="Sales trend by period">
            <Suspense fallback={<ProductAttributeSkeleton />}>
              <div className="mt-6">
                <TrendTableSection
                  supabase={supabase}
                  scope={resolveTableScope(searchParams, TREND_TABLE_PREFIX, pageScope)}
                  storeNames={storeNames}
                  storeOptions={storeOptionIds}
                  today={today}
                />
              </div>
            </Suspense>
          </SectionErrorBoundary>

          <SectionErrorBoundary label="Period comparison">
            <Suspense fallback={<ProductAttributeSkeleton />}>
              <div className="mt-6">
                <PeriodComparisonSection
                  supabase={supabase}
                  scope={resolveTableScope(searchParams, COMPARE_TABLE_PREFIX, pageScope)}
                  storeNames={storeNames}
                  storeOptions={storeOptionIds}
                />
              </div>
            </Suspense>
          </SectionErrorBoundary>

          <SectionErrorBoundary label="Agent-wise sales">
            <Suspense fallback={<ProductAttributeSkeleton />}>
              <div className="mt-6">
                <AgentTableSection
                  supabase={supabase}
                  scope={resolveTableScope(searchParams, AGENT_TABLE_PREFIX, pageScope)}
                  storeNames={storeNames}
                  storeOptions={storeOptionIds}
                />
              </div>
            </Suspense>
          </SectionErrorBoundary>

          <SectionErrorBoundary label="Product attribute breakdown">
            <Suspense fallback={<ProductAttributeSkeleton />}>
              <div className="mt-6">
                <ProductAttributeSection
                  supabase={supabase}
                  scope={resolveTableScope(searchParams, ATTR_TABLE_PREFIX, pageScope)}
                  storeNames={storeNames}
                  storeOptions={storeOptionIds}
                />
              </div>
            </Suspense>
          </SectionErrorBoundary>

          <SectionErrorBoundary label="Footfall & diagnosis">
            <Suspense fallback={<FootfallDiagnosisSkeleton />}>
              <div className="mt-8">
                <FootfallDiagnosisSection
                  supabase={supabase}
                  applyStore={applyStore}
                  scope={resolveTableScope(searchParams, FOOTFALL_PREFIX, pageScope)}
                  storeNames={storeNames}
                  today={today}
                />
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
