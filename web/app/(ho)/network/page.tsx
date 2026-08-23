import { Suspense } from "react";
import { createClient } from "@/lib/data/client";
import type { DataClient, QueryChain } from "@/lib/data/client";
import { requirePageAccess } from "@/lib/auth/roles";
import { resolveViewScope, type VerticalKey } from "@/lib/scope/resolveViewScope";
import { ScopeBar } from "@/components/ui/ScopeBar";
import { KpiCard } from "@/components/ui/KpiCard";
import { Pill } from "@/components/ui/Pill";
import { TrendChart } from "@/components/ui/TrendChart";
import { HourlyBarChart } from "@/components/ui/HourlyBarChart";
import { MultiSelectFilter } from "@/components/ui/StoreFilter";
import { KpiGridSkeleton, ChartSkeleton, TableSkeleton, MatrixSkeleton, SectionLabelSkeleton } from "@/components/ui/Skeleton";
import { SectionErrorBoundary } from "@/components/ui/SectionErrorBoundary";
import { timeAll } from "@/lib/perf/timing";
import {
  computeSalesTotals,
  computeLeague,
  computeSchemeRows,
  computeTrendPoints,
  computeHourlyPoints,
  computeAgentRows,
  buildWeekSeries as buildWeekSeriesShared,
  HOUR_START,
  HOUR_END,
  type AgentDailyRow,
} from "@/lib/sales/aggregate";
import { computeStoreExceptions } from "@/lib/sales/exceptions";
import { getMyAlertSubscription } from "@/lib/alerts/actions";
import { AlertSubscriptionToggle } from "./AlertSubscriptionToggle";
import {
  computeFootfallInsights,
  type MatrixEntry,
  type ConversionRow,
  type CompletenessRow,
} from "@/lib/network/footfall";
import { MatrixCell, TrafficSalesCell } from "@/components/ui/FootfallMatrixCells";
import { resolveAccess } from "@/lib/auth/access";
import { StoreLeagueFacetedContent } from "./StoreLeagueFacetedContent";
import { AgentSalesFacetedTable } from "./AgentSalesFacetedTable";
import { StoreDiagnosisFacetedTable } from "./StoreDiagnosisFacetedTable";

export const dynamic = "force-dynamic";

// Row shapes for each query below — only the fields this page actually
// reads, not the full view. select("*") queries still only need these
// declared; the rest of each view's columns exist in the DB but nothing
// here touches them.
type DailyRow = { store_id: string | null; bill_date: string | null; net_sales: number | string };
type WeeklyRow = {
  week_start: string | null;
  retail_week: number | null;
  store_id: string | null;
  net_sales: number | string;
  gross_sales: number | string;
  discount: number | string;
  sale_bills: number | string;
  sale_quantity: number | string;
  is_complete_week: boolean;
};
type SchemeDailyRow = { scheme_group: string | null; quantity: number | string | null; net_sales: number | string | null };
type StoreRow = { store_id: string; store_name: string; city: string };
type ActionSummary = { open_count: number | null; closed_unmeasured_count: number | null };
type HourlyRow = { bill_hour: number | null; net_sales: number | string };
// sales.vw_ecomm_daily (0067) — only the fields the rollup card below reads.
type EcommDailyRow = { channel: string; order_date: string; net_selling_value: number | string };

const INR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const num = (v: number | string) => (typeof v === "string" ? Number(v) : v);
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

type ApplyStore = <T extends { eq: (col: string, val: string) => T; in: (col: string, vals: string[]) => T }>(
  q: T,
  col?: string
) => T;

// Quadrant/Assessment/assess()/MatrixEntry/QUADRANT_AXES/TrafficSalesQuadrant/
// TRAFFIC_SALES_META/trafficSalesQuadrant() moved to lib/network/footfall.ts,
// and the MatrixCell/TrafficSalesCell renderers moved to
// components/ui/FootfallMatrixCells.tsx (both 2026-08-20) — imported above —
// so the Workspace Builder's footfall components render identically to this
// page instead of via a hand-resynced copy.

// ---------------------------------------------------------------------------
// computeSalesTotals / computeLeague / computeSchemeRows now live in
// lib/sales/aggregate.ts (Phase 5) — imported above — so the Workspace
// Builder's dynamically-rendered Sales components call the exact same
// functions this page does, rather than a second hand-synced copy.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Vertical rollup + exceptions — independently streamed section, part of
// Phase 1 of the BI UI/UX architecture work (see the plan file for the full
// design). Deliberately its own small queries against the same cheap
// pre-aggregated views SalesSection/FootfallSection already use, rather
// than lifting shared state up a level — same "disclosed duplication to
// preserve independent streaming" trade-off FootfallSection's own header
// comment documents below.
//
// Exceptions here are EBO-only and WoW-sales-decline-only in this first
// version: a per-store diagnosis needs footfall data too (see
// FootfallSection's storeDiagnosis), which isn't cheap enough to duplicate
// a third time — a real ECOM/stock-based exception feed is later work, not
// faked here.
// ---------------------------------------------------------------------------
async function OverviewRollupSection({
  supabase,
  applyStore,
  from,
  to,
  weeklyStart,
  prevFrom,
  prevTo,
  storeNames,
  businessUnits,
  selectedVerticals,
}: {
  supabase: DataClient;
  applyStore: ApplyStore;
  from: string;
  to: string;
  weeklyStart: Date;
  prevFrom: Date;
  prevTo: Date;
  storeNames: Map<string, string>;
  businessUnits: string[];
  selectedVerticals: VerticalKey[];
}) {
  const showEbo = selectedVerticals.length === 0 || selectedVerticals.includes("ebo");
  const showEcomm = businessUnits.includes("ecomm") && (selectedVerticals.length === 0 || selectedVerticals.includes("ecomm"));

  const [{ data: weeks }, { data: ecommNow }, { data: ecommPrev }] = await timeAll("network:rollup", [
    applyStore(supabase.schema("sales").from<WeeklyRow>("vw_ebo_sales_weekly").select("*").gte("week_start", isoDate(weeklyStart)).lte("week_start", to) as unknown as QueryChain<WeeklyRow>),
    showEcomm
      ? (supabase.schema("sales").from<EcommDailyRow>("vw_ecomm_daily").select("channel, order_date, net_selling_value").gte("order_date", from).lte("order_date", to) as unknown as QueryChain<EcommDailyRow>)
      : Promise.resolve({ data: [] as EcommDailyRow[] }),
    showEcomm
      ? (supabase.schema("sales").from<EcommDailyRow>("vw_ecomm_daily").select("channel, order_date, net_selling_value").gte("order_date", isoDate(prevFrom)).lte("order_date", isoDate(prevTo)) as unknown as QueryChain<EcommDailyRow>)
      : Promise.resolve({ data: [] as EcommDailyRow[] }),
  ] as const);

  const { totalNetSales: eboNet, wow: eboWow, weekRows, storesInView } = computeSalesTotals(weeks, from);

  const ecommNet = (ecommNow ?? []).reduce((s, r) => s + num(r.net_selling_value), 0);
  const ecommPrevNet = (ecommPrev ?? []).reduce((s, r) => s + num(r.net_selling_value), 0);
  const ecommDelta = ecommPrevNet > 0 ? ((ecommNet - ecommPrevNet) / ecommPrevNet) * 100 : null;

  const networkNet = (showEbo ? eboNet : 0) + (showEcomm ? ecommNet : 0);

  // Worst-performing stores by their own latest-week net-sales change — see
  // lib/sales/exceptions.ts for why this is a shared extraction (the
  // threshold-alerts email digest reuses the exact same definition).
  const exceptions = computeStoreExceptions(weekRows, storesInView, storeNames);

  // Feature gates (0079) — cached per request, see SalesSection's note.
  const access = await resolveAccess();
  if (!access) return null;

  return (
    <>
      {access.can("network.vertical_rollup.view") && (
      <>
      <span className="mt-6 block text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
        Vertical rollup
      </span>
      <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard label="Network · All" value={INR(networkNet)} sub={eboWow !== null ? `${eboWow >= 0 ? "+" : ""}${eboWow.toFixed(1)}% EBO WoW` : undefined} />
        {showEbo && (
          <KpiCard label="EBO" value={INR(eboNet)} sub={eboWow !== null ? `${eboWow >= 0 ? "+" : ""}${eboWow.toFixed(1)}% WoW` : "need 2 complete weeks"} />
        )}
        {showEcomm && (
          <KpiCard
            label="ECOM"
            value={INR(ecommNet)}
            sub={ecommDelta !== null ? `${ecommDelta >= 0 ? "+" : ""}${ecommDelta.toFixed(1)}% vs prior period` : undefined}
          />
        )}
        <KpiCard label="MBO" value="—" sub="Pipeline not connected" tone="muted" />
        <KpiCard label="LFS" value="—" sub="Pipeline not connected" tone="muted" />
      </div>
      </>
      )}

      {access.can("network.exceptions.view") && (
      <div className="mt-4 border border-line-soft">
        <div className="flex items-center justify-between border-b border-line-soft bg-surface-2 px-3 py-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">Needs attention — EBO sales</span>
          <span className="text-[11px] text-ink-3">
            {exceptions.length > 0 ? `${exceptions.length} store${exceptions.length === 1 ? "" : "s"}, latest week vs prior` : "latest week vs prior"}
          </span>
        </div>
        {exceptions.length > 0 ? (
          <ul>
            {exceptions.map((e) => (
              <li key={e.storeId} className="flex items-center gap-3 border-b border-line-soft px-3 py-2 text-[13px] last:border-0">
                <Pill tone={e.netChangePct < -20 ? "crit" : "warn"}>{e.netChangePct.toFixed(1)}%</Pill>
                <span className="flex-1">{e.name}</span>
                <span className="font-mono text-ink-3">{INR(e.net)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-3 py-3 text-[12.5px] text-ink-3">No stores below threshold right now.</p>
        )}
        {/* An 'edit' key, not 'view': the toggle SUBSCRIBES the user to a
            daily email. Denying it leaves the list readable but removes the
            ability to opt into the digest. */}
        {access.can("network.alert_subscription.edit") && (
          <AlertSubscriptionToggle initial={await getMyAlertSubscription()} />
        )}
      </div>
      )}
    </>
  );
}

function OverviewRollupSectionSkeleton() {
  return (
    <>
      <SectionLabelSkeleton />
      <KpiGridSkeleton count={5} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Sales & Trends — independently streamed section.
//
// Fetches only what THIS section renders (5 of the page's original 10
// queries) so it can pop in as soon as its own data is ready, without
// waiting on footfall/conversion queries that have nothing to do with it.
// ---------------------------------------------------------------------------
async function SalesSection({
  supabase,
  applyStore,
  from,
  to,
  weeklyStart,
  storeNames,
}: {
  supabase: DataClient;
  applyStore: ApplyStore;
  from: string;
  to: string;
  weeklyStart: Date;
  storeNames: Map<string, string>;
}) {
  const [
    { data: daily, error: dailyErr },
    { data: weeks, error: weeklyErr },
    { data: schemeDaily },
    { data: agentDaily },
    { data: hourly },
  ] = await timeAll("network:sales", [
    applyStore(supabase.schema("sales").from<DailyRow>("vw_ebo_sales_daily").select("*").gte("bill_date", from).lte("bill_date", to).order("bill_date") as unknown as QueryChain<DailyRow>),
    applyStore(supabase.schema("sales").from<WeeklyRow>("vw_ebo_sales_weekly").select("*").gte("week_start", isoDate(weeklyStart)).lte("week_start", to).order("week_start") as unknown as QueryChain<WeeklyRow>),
    applyStore(supabase.schema("sales").from<SchemeDailyRow>("vw_ebo_scheme_daily").select("*").gte("bill_date", from).lte("bill_date", to) as unknown as QueryChain<SchemeDailyRow>),
    applyStore(supabase.schema("sales").from<AgentDailyRow>("vw_ebo_agent_daily").select("*").gte("bill_date", from).lte("bill_date", to) as unknown as QueryChain<AgentDailyRow>),
    applyStore(supabase.schema("sales").from<HourlyRow>("vw_ebo_sales_hourly").select("*").gte("bill_date", from).lte("bill_date", to) as unknown as QueryChain<HourlyRow>),
  ] as const);

  if (dailyErr || weeklyErr) {
    return (
      <p className="py-8 text-crit">
        Couldn&apos;t load network sales: {dailyErr?.message ?? weeklyErr?.message}
      </p>
    );
  }

  // --- Network KPI totals from the weekly view — see 0005's comments on
  // why ATV/UPT must come from SALE-bills-only figures, not daily's
  // net_sales/net_quantity (which include returns). ---
  const {
    weekRows,
    totalNetSales,
    totalGrossSales,
    totalDiscount,
    totalSaleBills,
    totalSaleQty,
    networkAtv,
    networkUpt,
    discountPct,
    salesPerUnit,
    storesInView,
  } = computeSalesTotals(weeks, from);

  // --- Week-wise sales value & qty. One table per store plus a network
  // total, rather than stores side by side — WOW% is only meaningful when
  // computed WITHIN a store's own series, so each table carries its own
  // growth/degrowth column. Side-by-side columns shared a single WOW,
  // which described the network and told you nothing about either store. ---
  type WeekRow = ReturnType<typeof buildWeekSeriesShared>[number];

  // When only one store is in view its series IS the network total, so the
  // duplicate table is skipped.
  const weekTables: { title: string; rows: WeekRow[] }[] = [
    ...storesInView.map((sid) => ({ title: storeNames.get(sid) ?? sid, rows: buildWeekSeriesShared(weekRows, sid) })),
    ...(storesInView.length > 1 ? [{ title: "Network total", rows: buildWeekSeriesShared(weekRows, null) }] : []),
  ];

  const weekLabel = (n: number) => `RW${String(n).padStart(2, "0")}`;
  const weekRangeLabel = (weekStart: string) => {
    const start = new Date(weekStart + "T00:00:00");
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const fmt = (d: Date) => d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
    return `${fmt(start)} – ${fmt(end)}`;
  };

  // --- Trend chart ---
  const trendPoints = computeTrendPoints(daily);

  // --- Store league ---
  const league = computeLeague(weekRows, storesInView, storeNames);

  // --- Scheme penetration, by quantity (not line count) ---
  const { schemeRows, schemeMaxQty } = computeSchemeRows(schemeDaily);

  // --- Agent-wise sales — moved to lib/sales/aggregate.ts's
  // computeAgentRows() (2026-08-20) so the Workspace's agent_sales_table
  // component calls the same function. ---
  const agentRows = computeAgentRows(agentDaily);

  // --- Hour-of-day, business hours only (9am-12am — stores aren't open overnight) ---
  const hourlyPoints = computeHourlyPoints(hourly);

  // Feature-level gates (0079). These tailor WHAT THIS PAGE RENDERS; they are
  // not a security boundary — RLS + core.fn_user_store_ids() still governs
  // what any query above could return, unchanged. resolveAccess() is cached
  // per request, so each section calling it is one query, not several.
  //
  // The queries above still run even when a section is hidden: skipping them
  // would mean threading the access set into timeAll's batch, and these are
  // the cheap pre-aggregated views. Revisit if an expensive section ever gets
  // gated.
  const access = await resolveAccess();
  if (!access) return null;

  return (
    <>
      <span className="mt-6 block text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Sales</span>
      <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <KpiCard label="Net sales" value={INR(totalNetSales)} sub={`gross ${INR(totalGrossSales)}`} />
        <KpiCard
          label="Discount"
          value={discountPct !== null ? `${discountPct.toFixed(1)}%` : "—"}
          sub={INR(totalDiscount) + " given"}
        />
        <KpiCard label="Sale bills" value={String(totalSaleBills)} />
        <KpiCard label="Units sold" value={String(totalSaleQty)} sub={salesPerUnit !== null ? `${INR(salesPerUnit)}/unit` : undefined} />
        <KpiCard label="ATV" value={networkAtv !== null ? INR(networkAtv) : "—"} />
        <KpiCard label="UPT" value={networkUpt !== null ? networkUpt.toFixed(2) : "—"} />
      </div>

      {access.can("network.week_wise_sales.view") && (
      <div className="mt-8">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
          Week-wise sales value &amp; quantity
        </span>
        <div className="mt-2 grid grid-cols-1 gap-5 xl:grid-cols-2">
          {weekTables.map((t) => (
            <div key={t.title} className="border border-line-soft">
              <div className="flex items-baseline justify-between border-b border-line-soft bg-surface-2 px-3 py-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">{t.title}</span>
                <span className="text-[11px] text-ink-3">{t.rows.length} weeks</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line-soft text-left text-[10px] uppercase tracking-wide text-ink-3">
                      <th className="px-3 py-2">Week</th>
                      <th className="px-3 py-2">Range</th>
                      <th className="px-3 py-2 text-right">Net sales</th>
                      <th className="px-3 py-2 text-right">Net WOW</th>
                      <th className="px-3 py-2 text-right">Qty</th>
                      <th className="px-3 py-2 text-right">Qty WOW</th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.rows.map((row) => (
                      <tr key={row.weekStart} className="border-b border-line-soft last:border-0">
                        <td className="px-3 py-1.5 font-semibold">{weekLabel(row.retailWeek)}</td>
                        <td className="px-3 py-1.5 text-ink-3">{weekRangeLabel(row.weekStart)}</td>
                        <td className="px-3 py-1.5 text-right font-mono">{INR(row.net)}</td>
                        <td
                          className={`px-3 py-1.5 text-right font-mono ${
                            row.netChangePct === null
                              ? "text-ink-3"
                              : row.netChangePct >= 0
                              ? "text-good"
                              : "text-crit"
                          }`}
                        >
                          {row.netChangePct !== null
                            ? `${row.netChangePct >= 0 ? "+" : ""}${row.netChangePct.toFixed(1)}%`
                            : "—"}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono">{row.qty}</td>
                        <td
                          className={`px-3 py-1.5 text-right font-mono ${
                            row.qtyChangePct === null
                              ? "text-ink-3"
                              : row.qtyChangePct >= 0
                              ? "text-good"
                              : "text-crit"
                          }`}
                        >
                          {row.qtyChangePct !== null
                            ? `${row.qtyChangePct >= 0 ? "+" : ""}${row.qtyChangePct.toFixed(1)}%`
                            : "—"}
                        </td>
                      </tr>
                    ))}
                    {t.rows.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-3 py-4 text-center text-sm text-ink-3">
                          No weeks in the selected range.
                        </td>
                      </tr>
                    )}
                  </tbody>
                  {t.rows.length > 0 && (
                    <tfoot>
                      <tr className="border-t border-line-soft bg-surface-2 font-semibold">
                        <td className="px-3 py-2" colSpan={2}>
                          Grand Total
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {INR(t.rows.reduce((s, r) => s + r.net, 0))}
                        </td>
                        <td></td>
                        <td className="px-3 py-2 text-right font-mono">
                          {t.rows.reduce((s, r) => s + r.qty, 0)}
                        </td>
                        <td></td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </div>
          ))}
        </div>
      </div>
      )}

      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-2">
        <div>
          <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
            Net sales by day — network
          </span>
          <div className="mt-2 border border-line-soft p-3">
            {trendPoints.length > 0 ? (
              <TrendChart points={trendPoints} ariaLabel="Daily net sales across the network" />
            ) : (
              <p className="py-10 text-center text-sm text-ink-3">No sales data in this window.</p>
            )}
          </div>

          <span className="mt-6 block text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
            Net sales by hour of day
          </span>
          <div className="mt-2 border border-line-soft p-3">
            {hourlyPoints.length > 0 ? (
              <HourlyBarChart
                points={hourlyPoints}
                ariaLabel="Net sales by hour of day, 9am to midnight"
                startHour={HOUR_START}
                endHour={HOUR_END}
              />
            ) : (
              <p className="py-10 text-center text-sm text-ink-3">
                No bill-time data in this window (older exports didn&apos;t include it).
              </p>
            )}
          </div>
        </div>

        <div>
          {access.can("network.store_league.view") && (
            <>
              <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Store league</span>
              <p className="mt-1 text-[11px] text-ink-3">Click a row for that store&apos;s own daily trend.</p>
              <div className="mt-2">
                <StoreLeagueFacetedContent league={league} from={from} to={to} />
              </div>
            </>
          )}

          {access.can("network.scheme_penetration.view") && (
          <>
          <span className="mt-6 block text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
            Scheme penetration (by units sold)
          </span>
          <div className="mt-2 border border-line-soft p-3">
            <div className="flex flex-col gap-2">
              {schemeRows.map(([group, v]) => (
                <div key={group} className="grid grid-cols-[140px_1fr_auto] items-center gap-3 text-[12.5px]">
                  <span className="truncate">{group}</span>
                  <span className="h-4 overflow-hidden bg-surface-2">
                    <span
                      className="block h-full bg-accent"
                      style={{ width: `${Math.max(2, (v.qty / schemeMaxQty) * 100)}%` }}
                    />
                  </span>
                  <span className="whitespace-nowrap font-mono text-ink-2">
                    {v.qty} units · {INR(v.net)}
                  </span>
                </div>
              ))}
              {schemeRows.length === 0 && <p className="text-sm text-ink-3">No scheme data in this window.</p>}
            </div>
          </div>
          </>
          )}

          {access.can("network.agent_sales.view") && (
            <>
              <span className="mt-6 block text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
                Agent-wise sales
              </span>
              <div className="mt-2">
                <AgentSalesFacetedTable rows={agentRows} storeNames={Object.fromEntries(storeNames)} />
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function SalesSectionSkeleton() {
  return (
    <>
      <SectionLabelSkeleton />
      <KpiGridSkeleton count={6} />
      <div className="mt-8">
        <SectionLabelSkeleton />
        <div className="mt-2 grid grid-cols-1 gap-5 xl:grid-cols-2">
          <TableSkeleton rows={4} cols={6} />
          <TableSkeleton rows={4} cols={6} />
        </div>
      </div>
      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-2">
        <div>
          <ChartSkeleton height={160} />
          <ChartSkeleton height={140} />
        </div>
        <TableSkeleton rows={6} cols={7} />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Footfall, Diagnosis & Opportunity — independently streamed section.
//
// Fetches its own conversion/completeness queries plus THREE queries
// (daily, weeks, schemeDaily) that are also fetched by SalesSection above —
// a deliberate, disclosed duplication. Those three are the cheapest queries
// on the page (small, pre-aggregated views), and duplicating them is what
// lets "More KPIs"/"Suggested actions" (which need BOTH sales-side figures
// like WOW/discount% AND footfall-side figures like flagged stores) render
// as one section that streams independently of Sales & Trends, instead of
// either blocking on it or silently going stale. See docs/HANDOFF or the
// Phase 1 blueprint note on this trade-off before "fixing" the duplication.
// ---------------------------------------------------------------------------
async function FootfallSection({
  supabase,
  applyStore,
  from,
  to,
  weeklyStart,
  prevFrom,
  prevTo,
  storeNames,
  today,
}: {
  supabase: DataClient;
  applyStore: ApplyStore;
  from: string;
  to: string;
  weeklyStart: Date;
  prevFrom: Date;
  prevTo: Date;
  storeNames: Map<string, string>;
  today: Date;
}) {
  const [
    { data: conversion },
    { data: prevConversion },
    { data: completeness },
    { data: daily },
    { data: weeks },
    { data: schemeDaily },
  ] = await timeAll("network:footfall", [
    applyStore(supabase.schema("ops").from<ConversionRow>("vw_ebo_conversion_daily").select("store_id, bill_date, footfall, sale_bills, net_sales").gte("bill_date", from).lte("bill_date", to) as unknown as QueryChain<ConversionRow>),
    applyStore(supabase.schema("ops").from<ConversionRow>("vw_ebo_conversion_daily").select("store_id, bill_date, footfall, sale_bills, net_sales").gte("bill_date", isoDate(prevFrom)).lte("bill_date", isoDate(prevTo)) as unknown as QueryChain<ConversionRow>),
    applyStore(supabase.schema("ops").from<CompletenessRow>("vw_footfall_completeness").select("store_id, date, has_footfall").gte("date", from).lte("date", to) as unknown as QueryChain<CompletenessRow>),
    applyStore(supabase.schema("sales").from<DailyRow>("vw_ebo_sales_daily").select("*").gte("bill_date", from).lte("bill_date", to).order("bill_date") as unknown as QueryChain<DailyRow>),
    applyStore(supabase.schema("sales").from<WeeklyRow>("vw_ebo_sales_weekly").select("*").gte("week_start", isoDate(weeklyStart)).lte("week_start", to).order("week_start") as unknown as QueryChain<WeeklyRow>),
    applyStore(supabase.schema("sales").from<SchemeDailyRow>("vw_ebo_scheme_daily").select("*").gte("bill_date", from).lte("bill_date", to) as unknown as QueryChain<SchemeDailyRow>),
  ] as const);

  // All KPI/matrix/table/insight derivation now lives in
  // lib/network/footfall.ts's computeFootfallInsights() (2026-08-20) — moved
  // verbatim so the Workspace Builder's footfall components call the exact
  // same function this page does. See that file for the full formulas and
  // the spec-§ references that used to sit inline here.
  const {
    totalFootfall,
    conversionPct,
    salesPerFootfall,
    footfallDaysCovered,
    totalDaysInRange,
    totalSaleBills,
    wow,
    discountPct,
    matrixEntries,
    matrixInsufficientData,
    completenessPct,
    expectedStoreDays,
    enteredStoreDays,
    missingToday,
    storeDiagnosis,
    topStore,
    bottomStore,
    schemePenetrationPct,
    flaggedStores,
    insights,
  } = computeFootfallInsights({ conversion, prevConversion, completeness, daily, weeks, schemeDaily, storeNames, today, from, prevFrom, prevTo });

  // Feature-level gates (0079) — see SalesSection's note on why this is view
  // tailoring rather than a security boundary. Cached per request.
  const access = await resolveAccess();
  if (!access) return null;

  return (
    <>
      <span className="mt-6 block text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
        Footfall &amp; growth
      </span>
      <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Footfall"
          value={footfallDaysCovered > 0 ? String(totalFootfall) : "—"}
          sub={footfallDaysCovered < totalDaysInRange ? `${footfallDaysCovered}/${totalDaysInRange} days entered` : "all days entered"}
          tone={footfallDaysCovered === 0 ? "muted" : "default"}
        />
        <KpiCard
          label="Conversion"
          value={conversionPct !== null ? `${conversionPct.toFixed(1)}%` : "—"}
          tone={conversionPct === null ? "muted" : "default"}
        />
        <KpiCard
          label="Sales per footfall"
          value={salesPerFootfall !== null ? INR(salesPerFootfall) : "—"}
          tone={salesPerFootfall === null ? "muted" : "default"}
        />
        <KpiCard
          label="WOW"
          value={wow !== null ? `${wow >= 0 ? "+" : ""}${wow.toFixed(1)}%` : "—"}
          sub={wow === null ? "need 2 complete weeks" : "last complete week"}
          tone={wow === null ? "muted" : "default"}
        />
      </div>

      <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Non-converting visits"
          value={totalFootfall > 0 ? String(totalFootfall - totalSaleBills) : "—"}
          sub="footfall − bills"
          tone={totalFootfall === 0 ? "muted" : "default"}
        />
        <KpiCard
          label="Footfall data completeness"
          value={completenessPct !== null ? `${completenessPct.toFixed(0)}%` : "—"}
          sub={`${enteredStoreDays} of ${expectedStoreDays} store-days`}
          tone={completenessPct !== null && completenessPct < 90 ? "muted" : "default"}
        />
        <KpiCard
          label="Missing today"
          value={String(missingToday)}
          sub={missingToday === 0 ? "all stores entered" : "stores not entered"}
          tone={missingToday > 0 ? "muted" : "default"}
        />
        <KpiCard
          label="Stores with traffic issues"
          value={String(
            // Falling footfall AND not otherwise doing fine — a store whose
            // footfall dipped while sales still grew isn't a problem to chase.
            storeDiagnosis.filter((s) => s.footfallChangePct < 0 && s.tone !== "good").length
          )}
          sub="footfall down & flagged"
        />
      </div>

      {completenessPct !== null && completenessPct < 90 && (
        <p className="mt-3 border-l-2 border-warn bg-warn-soft px-3 py-2 text-sm text-ink-2">
          Footfall is missing for {expectedStoreDays - enteredStoreDays} store-day
          {expectedStoreDays - enteredStoreDays === 1 ? "" : "s"} in this range — conversion and
          sales-per-visitor below are computed only on days that have footfall, so treat them as
          indicative rather than exact.
        </p>
      )}

      <span className="mt-6 block text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
        More KPIs
      </span>
      <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Top store"
          value={topStore ? topStore.name : "—"}
          sub={topStore ? INR(topStore.net) : undefined}
        />
        <KpiCard
          label="Weakest store"
          value={bottomStore ? bottomStore.name : "—"}
          sub={bottomStore ? INR(bottomStore.net) : undefined}
          tone={bottomStore ? "muted" : "default"}
        />
        <KpiCard
          label="Scheme penetration"
          value={schemePenetrationPct !== null ? `${schemePenetrationPct.toFixed(0)}%` : "—"}
          sub="units sold on a scheme"
          tone={schemePenetrationPct === null ? "muted" : "default"}
        />
        <KpiCard
          label="Stores flagged"
          value={String(flaggedStores.length)}
          sub="need attention this period"
          tone={flaggedStores.length > 0 ? "muted" : "default"}
        />
      </div>

      {insights.length > 0 && (
        <div className="mt-4 border-l-2 border-accent bg-accent-soft px-4 py-3">
          <span className="text-[10.5px] font-semibold uppercase tracking-wide text-accent-ink">
            Suggested actions
          </span>
          <ul className="mt-2 space-y-1.5 text-[13px] text-ink-2">
            {insights.map((line, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-accent">•</span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {access.can("network.footfall_matrix.view") && (
      <div className="mt-8">
        <div className="flex items-baseline justify-between">
          <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
            Footfall × conversion matrix
          </span>
          <span className="text-[11.5px] text-ink-3">
            vs {isoDate(prevFrom)} – {isoDate(prevTo)}
          </span>
        </div>

        {footfallDaysCovered > 0 ? (
          <>
            {/*
              overflow-x-auto + min-width, same pattern as the tables below —
              at phone widths the 3-column quadrant grid can't shrink further
              without the "prev → now" figures wrapping into an unreadable
              stack, so it scrolls horizontally instead of squashing.
            */}
            <div className="mt-2 overflow-x-auto border border-line-soft">
              <div className="grid min-w-[560px] grid-cols-[90px_1fr_1fr] gap-px bg-line-soft text-[12.5px]">
                <div className="bg-surface-2" />
                <div className="bg-surface-2 px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wide text-ink-3">
                  Conversion up
                </div>
                <div className="bg-surface-2 px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wide text-ink-3">
                  Conversion down
                </div>

                <div className="flex items-center justify-center bg-surface-2 px-2 text-center text-[10px] font-semibold uppercase tracking-wide text-ink-3">
                  Footfall up
                </div>
                <MatrixCell quadrant="healthy" entries={matrixEntries} />
                <MatrixCell quadrant="conversion_opportunity" entries={matrixEntries} />

                <div className="flex items-center justify-center bg-surface-2 px-2 text-center text-[10px] font-semibold uppercase tracking-wide text-ink-3">
                  Footfall down
                </div>
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
              <a href="/footfall" className="underline">
                the footfall entry screen
              </a>
              . Nothing here is guessed in the meantime.
            </p>
          </div>
        )}
      </div>
      )}

      {matrixEntries.length > 0 && access.can("network.traffic_sales_matrix.view") && (
        <div className="mt-8">
          <div className="flex items-baseline justify-between">
            <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
              Traffic vs sales matrix
            </span>
            <span className="text-[11px] text-ink-3">
              {isoDate(prevFrom)} – {isoDate(prevTo)} → {from} – {to}
            </span>
          </div>
          <p className="mt-1 text-[11.5px] text-ink-3">
            Is traffic turning into money? Separate question from the grid above, which asks which
            lever moved.
          </p>
          <div className="mt-2 overflow-x-auto border border-line-soft">
            <div className="grid min-w-[560px] grid-cols-[90px_1fr_1fr] gap-px bg-line-soft text-[12.5px]">
              <div className="bg-surface-2" />
              <div className="bg-surface-2 px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wide text-ink-3">
                Sales up
              </div>
              <div className="bg-surface-2 px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wide text-ink-3">
                Sales down
              </div>

              <div className="flex items-center justify-center bg-surface-2 px-2 text-center text-[10px] font-semibold uppercase tracking-wide text-ink-3">
                Footfall up
              </div>
              <TrafficSalesCell quadrant="growth_engine" entries={matrixEntries} />
              <TrafficSalesCell quadrant="efficiency_opportunity" entries={matrixEntries} />

              <div className="flex items-center justify-center bg-surface-2 px-2 text-center text-[10px] font-semibold uppercase tracking-wide text-ink-3">
                Footfall down
              </div>
              <TrafficSalesCell quadrant="positive_efficiency" entries={matrixEntries} />
              <TrafficSalesCell quadrant="traffic_problem" entries={matrixEntries} />
            </div>
          </div>
        </div>
      )}

      {storeDiagnosis.length > 0 && access.can("network.store_diagnosis.view") && (
        <div className="mt-8">
          <div className="flex items-baseline justify-between">
            <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
              Store diagnosis &amp; opportunity
            </span>
            <span className="text-[11px] text-ink-3">
              vs {isoDate(prevFrom)} – {isoDate(prevTo)}
            </span>
          </div>
          <div className="mt-2">
            <StoreDiagnosisFacetedTable rows={storeDiagnosis} />
          </div>
          <p className="mt-2 text-[11.5px] text-ink-3">
            Opportunity is an <strong>estimate</strong>: what this store&apos;s sales would have been
            at its own prior-period footfall and the better of its two conversion rates, minus
            actual — a single combined ceiling, not traffic and conversion opportunities added
            together (those overlap and would double-count). Benchmarks are the store&apos;s own
            previous period; peer benchmarking needs store size/age/type data that isn&apos;t
            captured yet. Stock is not a factor in these recommendations — no stock feed exists,
            so a &ldquo;marketing support&rdquo; suggestion here has not ruled out a stock problem.
          </p>
        </div>
      )}
    </>
  );
}

function FootfallSectionSkeleton() {
  return (
    <>
      <SectionLabelSkeleton />
      <KpiGridSkeleton count={4} />
      <div className="mt-2">
        <KpiGridSkeleton count={4} />
      </div>
      <div className="mt-6">
        <KpiGridSkeleton count={4} />
      </div>
      <div className="mt-8">
        <SectionLabelSkeleton />
        <MatrixSkeleton />
      </div>
      <div className="mt-8">
        <TableSkeleton rows={5} cols={8} />
      </div>
    </>
  );
}

export default async function NetworkPage({
  searchParams,
}: {
  // store: comma-separated store_ids, multi-select (0038). bu: comma-
  // separated vertical keys, multi-select (Phase 1 of the BI UI/UX work) —
  // same convention, same "empty/absent = all granted" default.
  searchParams: { from?: string; to?: string; store?: string; bu?: string };
}) {
  // requirePageAccess (migration 0035) layers a per-user override on top of
  // the role default — (ho)/layout.tsx's gate is coarse (it also hosts
  // /targets, a different page_key), so the "network" page_key check has to
  // happen here instead. This page previously had no per-page gate of its
  // own (only the layout's), so this is a new check, not a swap.
  const user = await requirePageAccess("network");
  const { verticals } = resolveViewScope(user);
  const selectedVerticals = (searchParams.bu ?? "").split(",").filter(Boolean) as VerticalKey[];

  const supabase = await createClient();

  const today = new Date();
  const defaultFrom = new Date(today);
  defaultFrom.setDate(defaultFrom.getDate() - 27);
  const from = searchParams.from ?? isoDate(defaultFrom);
  const to = searchParams.to ?? isoDate(today);

  // Store filter — multi-select (comma-separated store_ids in the URL).
  // Narrowing only — every view below already filters to the caller's
  // permitted stores via core.fn_user_store_ids(), so this can never widen
  // what a user sees, only focus it. Empty = no filter ("all stores").
  const storeFilters = (searchParams.store ?? "").split(",").filter(Boolean);
  const applyStore: ApplyStore = (q, col = "store_id") => {
    if (storeFilters.length === 0) return q;
    if (storeFilters.length === 1) return q.eq(col, storeFilters[0] as string);
    return q.in(col, storeFilters);
  };

  // Weekly window needs to reach back one extra week before `from` so WOW
  // can compare the week before the range starts, not just weeks inside it.
  const weeklyStart = new Date(from);
  weeklyStart.setDate(weeklyStart.getDate() - 7);

  // Previous period, same length, immediately before `from` — what the
  // footfall x conversion matrix compares each store's trend against. A
  // period-over-period comparison (not a fixed "last week"), so it tracks
  // whatever range the date picker has selected.
  const periodDays = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1;
  const prevTo = new Date(from);
  prevTo.setDate(prevTo.getDate() - 1);
  const prevFrom = new Date(prevTo);
  prevFrom.setDate(prevFrom.getDate() - (periodDays - 1));

  // --- Shell data: small, fast, non-user-scoped-enough-to-matter queries
  // that the header (store filter dropdown, action-queue banner) needs
  // immediately. Awaited directly (not streamed) — this is what lets the
  // page shell + filters paint before either heavy section below is ready,
  // per the "shell appears immediately" requirement. ---
  const [{ data: stores }, { data: actionSummary }] = await timeAll("network:shell", [
    supabase.schema("core").from<StoreRow>("stores").select("store_id, store_name, city").order("store_id") as unknown as QueryChain<StoreRow>,
    supabase.schema("ops").from<ActionSummary>("vw_action_queue_summary").select("*").maybeSingle() as unknown as Promise<{ data: ActionSummary | null }>,
  ] as const);

  const storeNames = new Map((stores ?? []).map((s) => [s.store_id, s.store_name]));

  return (
    <main className="py-6">
      <h1 className="font-serif text-2xl">Overview</h1>

      <div className="mt-3">
        <ScopeBar
          verticals={verticals}
          selectedVerticals={selectedVerticals}
          from={from}
          to={to}
          locationSlot={
            <MultiSelectFilter
              paramName="store"
              options={(stores ?? []).map((s) => s.store_id)}
              labels={Object.fromEntries((stores ?? []).map((s) => [s.store_id, s.store_name]))}
              selected={storeFilters}
              allLabel="All stores"
            />
          }
        />
      </div>

      {actionSummary && (actionSummary.open_count ?? 0) > 0 && (
        <p className="mt-3 border-l-2 border-warn bg-warn-soft px-3 py-2 text-sm text-ink-2">
          {actionSummary.open_count} open action{actionSummary.open_count === 1 ? "" : "s"} in the queue
          {(actionSummary.closed_unmeasured_count ?? 0) > 0
            ? ` · ${actionSummary.closed_unmeasured_count} closed without a measured result`
            : ""}
        </p>
      )}

      <SectionErrorBoundary label="Vertical rollup">
        <Suspense fallback={<OverviewRollupSectionSkeleton />}>
          <OverviewRollupSection
            supabase={supabase}
            applyStore={applyStore}
            from={from}
            to={to}
            weeklyStart={weeklyStart}
            prevFrom={prevFrom}
            prevTo={prevTo}
            storeNames={storeNames}
            businessUnits={user.businessUnits}
            selectedVerticals={selectedVerticals}
          />
        </Suspense>
      </SectionErrorBoundary>

      <SectionErrorBoundary label="Sales & Trends">
        <Suspense fallback={<SalesSectionSkeleton />}>
          <SalesSection
            supabase={supabase}
            applyStore={applyStore}
            from={from}
            to={to}
            weeklyStart={weeklyStart}
            storeNames={storeNames}
          />
        </Suspense>
      </SectionErrorBoundary>

      <SectionErrorBoundary label="Footfall & Diagnosis">
        <Suspense fallback={<FootfallSectionSkeleton />}>
          <FootfallSection
            supabase={supabase}
            applyStore={applyStore}
            from={from}
            to={to}
            weeklyStart={weeklyStart}
            prevFrom={prevFrom}
            prevTo={prevTo}
            storeNames={storeNames}
            today={today}
          />
        </Suspense>
      </SectionErrorBoundary>
    </main>
  );
}
