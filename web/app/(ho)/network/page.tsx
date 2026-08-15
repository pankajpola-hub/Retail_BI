import { createClient } from "@/lib/data/client";
import { requirePageAccess } from "@/lib/auth/roles";
import { KpiCard } from "@/components/ui/KpiCard";
import { Pill } from "@/components/ui/Pill";
import { TrendChart } from "@/components/ui/TrendChart";
import { HourlyBarChart } from "@/components/ui/HourlyBarChart";
import { DateRangePicker } from "@/components/ui/DateRangePicker";
import { MultiSelectFilter } from "@/components/ui/StoreFilter";

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
type ConversionRow = {
  store_id: string | null;
  bill_date: string;
  footfall: number | null;
  sale_bills: number | string;
  net_sales: number | string;
};
type ActionSummary = { open_count: number | null; closed_unmeasured_count: number | null };
type AgentDailyRow = { store_id: string | null; agent_name: string | null; bills: number | string; quantity: number | string; net_sales: number | string };
type HourlyRow = { bill_hour: number | null; net_sales: number | string };
type CompletenessRow = { store_id: string | null; date: string; has_footfall: boolean };

const INR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const DAY_LABEL = (iso: string) =>
  new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

type Quadrant = "healthy" | "conversion_opportunity" | "marketing_opportunity" | "critical";

type Assessment = {
  quadrant: Quadrant;
  tone: "good" | "warn" | "crit" | "neutral";
  headline: string;
  primaryIssue: string;
  recommendation: string;
};

/**
 * SINGLE source of truth for "how is this store doing".
 *
 * The matrix and the diagnosis table below both call this. They used to
 * classify independently — the matrix on footfall/conversion direction
 * alone, the table on sales first — which let them contradict each other
 * (a store shown as "Conversion opportunity" in the matrix while the table
 * said "None — sales up"). Anything sales-aware belongs here so both stay
 * consistent by construction.
 *
 * Quadrant placement stays purely footfall x conversion, because those ARE
 * the matrix's two axes — but the severity, headline and recommended action
 * all account for what sales actually did. A store growing its sales is not
 * "an opportunity" in the problem sense, whichever way its levers moved.
 */
function assess(
  footfallChangePct: number,
  conversionChangePts: number,
  salesChangePct: number | null
): Assessment {
  const footfallUp = footfallChangePct >= 0;
  const conversionUp = conversionChangePts >= 0;
  const quadrant: Quadrant =
    footfallUp && conversionUp
      ? "healthy"
      : footfallUp
      ? "conversion_opportunity"
      : conversionUp
      ? "marketing_opportunity"
      : "critical";

  if (salesChangePct === null) {
    return {
      quadrant,
      tone: "neutral",
      headline: "Not enough data",
      primaryIssue: "—",
      recommendation: "—",
    };
  }

  if (salesChangePct >= 0) {
    switch (quadrant) {
      case "healthy":
        return {
          quadrant,
          tone: "good",
          headline: "Healthy growth",
          primaryIssue: "None — all levers up",
          recommendation: "Study & replicate",
        };
      case "conversion_opportunity":
        return {
          quadrant,
          tone: "good",
          headline: "Growing, conversion slipping",
          primaryIssue: "None — sales up",
          recommendation: "Watch conversion",
        };
      case "marketing_opportunity":
        return {
          quadrant,
          tone: "good",
          headline: "Growing on fewer visitors",
          primaryIssue: "None — sales up",
          recommendation: "Rebuild traffic to extend",
        };
      case "critical":
        // Both levers down but sales up means ATV alone is carrying it —
        // real growth, but resting on one lever, so flagged not celebrated.
        return {
          quadrant,
          tone: "warn",
          headline: "Sales up on ATV alone",
          primaryIssue: "ATV carrying growth",
          recommendation: "Fragile — rebuild traffic",
        };
    }
  }

  switch (quadrant) {
    case "healthy":
      // Footfall and conversion both up yet sales down — only ATV/mix can
      // explain that.
      return {
        quadrant,
        tone: "warn",
        headline: "Levers up, sales down",
        primaryIssue: "ATV / mix",
        recommendation: "Category & pricing review",
      };
    case "conversion_opportunity":
      return {
        quadrant,
        tone: "warn",
        headline: "Conversion opportunity",
        primaryIssue: "Conversion",
        recommendation: "Store ops / staffing",
      };
    case "marketing_opportunity":
      return {
        quadrant,
        tone: "warn",
        headline: "Marketing opportunity",
        primaryIssue: "Footfall",
        recommendation: "Marketing support",
      };
    case "critical":
      return {
        quadrant,
        tone: "crit",
        headline: "Critical",
        primaryIssue: "Footfall + conversion",
        recommendation: "Check stock before spending",
      };
  }
}

type MatrixEntry = {
  storeId: string;
  name: string;
  // Raw values on BOTH sides of every comparison. Deltas alone can't be
  // sanity-checked ("−7%" of what?), and with footfall entry being manual
  // it matters that a reader can see the actual counts a verdict rests on.
  footfallNow: number;
  footfallPrev: number;
  footfallChangePct: number;
  conversionNow: number;
  conversionPrev: number;
  conversionChangePts: number;
  salesNow: number;
  salesPrev: number;
  salesChangePct: number | null;
} & Assessment;

// Describes what the BOX means (its axes), not a verdict — the verdict is
// per store, since two stores in the same box can be doing opposite things
// depending on what sales did.
const QUADRANT_AXES: Record<Quadrant, string> = {
  healthy: "Footfall ↑ · Conversion ↑",
  conversion_opportunity: "Footfall ↑ · Conversion ↓",
  marketing_opportunity: "Footfall ↓ · Conversion ↑",
  critical: "Footfall ↓ · Conversion ↓",
};

const INR_SHORT = (n: number) =>
  n >= 100000 ? `₹${(n / 100000).toFixed(2)}L` : `₹${Math.round(n).toLocaleString("en-IN")}`;

function MatrixCell({ quadrant, entries }: { quadrant: Quadrant; entries: MatrixEntry[] }) {
  const rows = entries.filter((e) => e.quadrant === quadrant);
  return (
    <div className="bg-surface p-3">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-3">
        {QUADRANT_AXES[quadrant]}
      </span>
      <div className="mt-2 flex flex-col gap-2.5">
        {rows.map((e) => (
          <div key={e.storeId}>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[12px] font-semibold">{e.name}</span>
              <Pill tone={e.tone}>{e.headline}</Pill>
            </div>
            <table className="mt-1 font-mono text-[11px] text-ink-3">
              <tbody>
                <tr>
                  <td className="pr-2">footfall</td>
                  <td className="pr-1 text-right tabular-nums">{e.footfallPrev}</td>
                  <td className="pr-1">→</td>
                  <td className="pr-2 text-right tabular-nums text-ink-2">{e.footfallNow}</td>
                  <td className={e.footfallChangePct >= 0 ? "text-good" : "text-crit"}>
                    {e.footfallChangePct >= 0 ? "+" : ""}
                    {e.footfallChangePct.toFixed(1)}%
                  </td>
                </tr>
                <tr>
                  <td className="pr-2">conversion</td>
                  <td className="pr-1 text-right tabular-nums">{e.conversionPrev.toFixed(1)}%</td>
                  <td className="pr-1">→</td>
                  <td className="pr-2 text-right tabular-nums text-ink-2">{e.conversionNow.toFixed(1)}%</td>
                  <td className={e.conversionChangePts >= 0 ? "text-good" : "text-crit"}>
                    {e.conversionChangePts >= 0 ? "+" : ""}
                    {e.conversionChangePts.toFixed(1)}pp
                  </td>
                </tr>
                <tr>
                  <td className="pr-2">sales</td>
                  <td className="pr-1 text-right tabular-nums">{INR_SHORT(e.salesPrev)}</td>
                  <td className="pr-1">→</td>
                  <td className="pr-2 text-right tabular-nums text-ink-2">{INR_SHORT(e.salesNow)}</td>
                  <td
                    className={
                      e.salesChangePct !== null && e.salesChangePct >= 0 ? "text-good" : "text-crit"
                    }
                  >
                    {e.salesChangePct !== null
                      ? `${e.salesChangePct >= 0 ? "+" : ""}${e.salesChangePct.toFixed(1)}%`
                      : "—"}
                  </td>
                </tr>
              </tbody>
            </table>
            <div className="mt-0.5 text-[11px] text-ink-2">→ {e.recommendation}</div>
          </div>
        ))}
        {rows.length === 0 && <span className="text-[12px] text-ink-3">—</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Traffic vs Sales matrix (spec §16)
//
// Different question from the footfall x conversion matrix above. That one
// asks "which lever moved?"; this one asks "is traffic translating into
// money?". A store can look fine on conversion and still be a traffic
// problem, or lose traffic while growing sales — this separates those.
// ---------------------------------------------------------------------------
type TrafficSalesQuadrant =
  | "growth_engine"
  | "efficiency_opportunity"
  | "positive_efficiency"
  | "traffic_problem";

const TRAFFIC_SALES_META: Record<
  TrafficSalesQuadrant,
  { label: string; axes: string; meaning: string; tone: "good" | "warn" | "crit" }
> = {
  growth_engine: {
    label: "Growth engine",
    axes: "Footfall ↑ · Sales ↑",
    meaning: "More traffic, more money. Find what's working and copy it.",
    tone: "good",
  },
  efficiency_opportunity: {
    label: "Efficiency opportunity",
    axes: "Footfall ↑ · Sales ↓",
    meaning: "Traffic is arriving but not converting into revenue — the store floor is the constraint, not marketing.",
    tone: "warn",
  },
  positive_efficiency: {
    label: "Positive efficiency",
    axes: "Footfall ↓ · Sales ↑",
    meaning: "Doing more with fewer visitors. Real, but capped — growth stalls once traffic runs out.",
    tone: "good",
  },
  traffic_problem: {
    label: "Traffic problem",
    axes: "Footfall ↓ · Sales ↓",
    meaning: "Fewer people, less money. Traffic is the first thing to fix.",
    tone: "crit",
  },
};

function trafficSalesQuadrant(footfallChangePct: number, salesChangePct: number | null): TrafficSalesQuadrant | null {
  if (salesChangePct === null) return null;
  const footfallUp = footfallChangePct >= 0;
  const salesUp = salesChangePct >= 0;
  if (footfallUp && salesUp) return "growth_engine";
  if (footfallUp && !salesUp) return "efficiency_opportunity";
  if (!footfallUp && salesUp) return "positive_efficiency";
  return "traffic_problem";
}

function TrafficSalesCell({
  quadrant,
  entries,
}: {
  quadrant: TrafficSalesQuadrant;
  entries: MatrixEntry[];
}) {
  const meta = TRAFFIC_SALES_META[quadrant];
  const rows = entries.filter((e) => trafficSalesQuadrant(e.footfallChangePct, e.salesChangePct) === quadrant);
  return (
    <div className="bg-surface p-3">
      <Pill tone={meta.tone}>{meta.label}</Pill>
      <p className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-ink-3">{meta.axes}</p>
      <p className="mt-1 text-[11px] leading-snug text-ink-3">{meta.meaning}</p>
      <div className="mt-2 flex flex-col gap-1.5">
        {rows.map((e) => (
          <div key={e.storeId} className="text-[12px]">
            <span className="font-semibold">{e.name}</span>
            <div className="font-mono text-[11px] text-ink-3">
              footfall {e.footfallPrev} → {e.footfallNow}{" "}
              <span className={e.footfallChangePct >= 0 ? "text-good" : "text-crit"}>
                ({e.footfallChangePct >= 0 ? "+" : ""}
                {e.footfallChangePct.toFixed(1)}%)
              </span>
            </div>
            <div className="font-mono text-[11px] text-ink-3">
              sales {INR_SHORT(e.salesPrev)} → {INR_SHORT(e.salesNow)}{" "}
              <span className={(e.salesChangePct ?? 0) >= 0 ? "text-good" : "text-crit"}>
                ({(e.salesChangePct ?? 0) >= 0 ? "+" : ""}
                {(e.salesChangePct ?? 0).toFixed(1)}%)
              </span>
            </div>
          </div>
        ))}
        {rows.length === 0 && <span className="text-[12px] text-ink-3">—</span>}
      </div>
    </div>
  );
}

export default async function NetworkPage({
  searchParams,
}: {
  searchParams: { from?: string; to?: string; store?: string }; // store: comma-separated store_ids, multi-select (0038)
}) {
  // requirePageAccess (migration 0035) layers a per-user override on top of
  // the role default — (ho)/layout.tsx's gate is coarse (it also hosts
  // /targets, a different page_key), so the "network" page_key check has to
  // happen here instead. This page previously had no per-page gate of its
  // own (only the layout's), so this is a new check, not a swap.
  await requirePageAccess("network");

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
  const applyStore = <T extends { eq: (col: string, val: string) => T; in: (col: string, vals: string[]) => T }>(
    q: T,
    col = "store_id"
  ): T => {
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

  const [
    { data: daily, error: dailyErr },
    { data: weeks, error: weeklyErr },
    { data: schemeDaily },
    { data: stores },
    { data: conversion },
    { data: prevConversion },
    { data: actionSummary },
    { data: agentDaily },
    { data: hourly },
    { data: completeness },
  ] = await Promise.all([
    applyStore(supabase.schema("sales").from<DailyRow>("vw_ebo_sales_daily").select("*").gte("bill_date", from).lte("bill_date", to).order("bill_date")),
    applyStore(supabase.schema("sales").from<WeeklyRow>("vw_ebo_sales_weekly").select("*").gte("week_start", isoDate(weeklyStart)).lte("week_start", to).order("week_start")),
    applyStore(supabase.schema("sales").from<SchemeDailyRow>("vw_ebo_scheme_daily").select("*").gte("bill_date", from).lte("bill_date", to)),
    supabase.schema("core").from<StoreRow>("stores").select("store_id, store_name, city").order("store_id"),
    applyStore(supabase.schema("ops").from<ConversionRow>("vw_ebo_conversion_daily").select("store_id, bill_date, footfall, sale_bills, net_sales").gte("bill_date", from).lte("bill_date", to)),
    applyStore(supabase.schema("ops").from<ConversionRow>("vw_ebo_conversion_daily").select("store_id, bill_date, footfall, sale_bills, net_sales").gte("bill_date", isoDate(prevFrom)).lte("bill_date", isoDate(prevTo))),
    supabase.schema("ops").from<ActionSummary>("vw_action_queue_summary").select("*").maybeSingle(),
    applyStore(supabase.schema("sales").from<AgentDailyRow>("vw_ebo_agent_daily").select("*").gte("bill_date", from).lte("bill_date", to)),
    applyStore(supabase.schema("sales").from<HourlyRow>("vw_ebo_sales_hourly").select("*").gte("bill_date", from).lte("bill_date", to)),
    applyStore(supabase.schema("ops").from<CompletenessRow>("vw_footfall_completeness").select("store_id, date, has_footfall").gte("date", from).lte("date", to)),
  ]);

  if (dailyErr || weeklyErr) {
    return (
      <p className="py-8 text-crit">
        Couldn&apos;t load network sales: {dailyErr?.message ?? weeklyErr?.message}
      </p>
    );
  }

  const storeNames = new Map((stores ?? []).map((s) => [s.store_id, s.store_name]));

  // --- Network KPI totals from the weekly view — see 0005's comments on
  // why ATV/UPT must come from SALE-bills-only figures, not daily's
  // net_sales/net_quantity (which include returns). ---
  const weekRows = (weeks ?? []).filter((w) => w.week_start && w.week_start >= from);
  const totalNetSales = weekRows.reduce((s, w) => s + Number(w.net_sales), 0);
  const totalGrossSales = weekRows.reduce((s, w) => s + Number(w.gross_sales), 0);
  const totalDiscount = weekRows.reduce((s, w) => s + Number(w.discount), 0);
  const totalSaleBills = weekRows.reduce((s, w) => s + Number(w.sale_bills), 0);
  const totalSaleQty = weekRows.reduce((s, w) => s + Number(w.sale_quantity), 0);
  const networkAtv = totalSaleBills > 0 ? totalNetSales / totalSaleBills : null;
  const networkUpt = totalSaleBills > 0 ? totalSaleQty / totalSaleBills : null;
  const discountPct = totalGrossSales > 0 ? (totalDiscount / totalGrossSales) * 100 : null;
  const salesPerUnit = totalSaleQty > 0 ? totalNetSales / totalSaleQty : null;

  // WOW: last two complete weeks touching the selected range.
  const completeWeeksByStart = new Map<string, number>();
  for (const w of (weeks ?? []).filter((w) => w.is_complete_week && w.week_start)) {
    const key = w.week_start as string;
    completeWeeksByStart.set(key, (completeWeeksByStart.get(key) ?? 0) + Number(w.net_sales));
  }
  const sortedCompleteWeeks = [...completeWeeksByStart.entries()].sort(([a], [b]) => a.localeCompare(b));
  const lastTwo = sortedCompleteWeeks.slice(-2);
  const wow =
    lastTwo.length === 2 && lastTwo[0] && lastTwo[1] && lastTwo[0][1] > 0
      ? ((lastTwo[1][1] - lastTwo[0][1]) / lastTwo[0][1]) * 100
      : null;

  // --- Week-wise sales value & qty. One table per store plus a network
  // total, rather than stores side by side — WOW% is only meaningful when
  // computed WITHIN a store's own series, so each table carries its own
  // growth/degrowth column. Side-by-side columns shared a single WOW,
  // which described the network and told you nothing about either store. ---
  // A store with rows in weekRows but zero actual sales in the selected
  // range (e.g. a discontinued store like Phoenix Palassio outside its
  // active period) doesn't get its own table/league row — an all-zero
  // block is noise, not a real absence-of-data case worth surfacing.
  const storesInView = [...new Set(weekRows.map((w) => w.store_id).filter((s): s is string => !!s))]
    .filter((sid) => weekRows.some((w) => w.store_id === sid && (Number(w.net_sales) > 0 || Number(w.sale_quantity) > 0)))
    .sort();

  type WeekRow = {
    retailWeek: number;
    weekStart: string;
    net: number;
    qty: number;
    netChangePct: number | null;
    qtyChangePct: number | null;
  };

  // Build one week series for a given store id, or for the whole network
  // when storeId is null.
  function buildWeekSeries(storeId: string | null): WeekRow[] {
    const acc = new Map<string, { retailWeek: number; weekStart: string; net: number; qty: number }>();
    for (const w of weekRows) {
      if (!w.week_start || w.retail_week === null || !w.store_id) continue;
      if (storeId !== null && w.store_id !== storeId) continue;
      const cur = acc.get(w.week_start) ?? { retailWeek: w.retail_week, weekStart: w.week_start, net: 0, qty: 0 };
      cur.net += Number(w.net_sales);
      cur.qty += Number(w.sale_quantity);
      acc.set(w.week_start, cur);
    }
    const sorted = [...acc.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
    return sorted.map((row, i) => {
      const prev = sorted[i - 1];
      return {
        ...row,
        netChangePct: prev && prev.net > 0 ? ((row.net - prev.net) / prev.net) * 100 : null,
        qtyChangePct: prev && prev.qty > 0 ? ((row.qty - prev.qty) / prev.qty) * 100 : null,
      };
    });
  }

  // When only one store is in view its series IS the network total, so the
  // duplicate table is skipped.
  const weekTables: { title: string; rows: WeekRow[] }[] = [
    ...storesInView.map((sid) => ({ title: storeNames.get(sid) ?? sid, rows: buildWeekSeries(sid) })),
    ...(storesInView.length > 1 ? [{ title: "Network total", rows: buildWeekSeries(null) }] : []),
  ];

  const weekLabel = (n: number) => `RW${String(n).padStart(2, "0")}`;
  const weekRangeLabel = (weekStart: string) => {
    const start = new Date(weekStart + "T00:00:00");
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const fmt = (d: Date) => d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
    return `${fmt(start)} – ${fmt(end)}`;
  };

  // --- Footfall / conversion KPIs ---
  const convRows = (conversion ?? []).filter((c) => c.footfall !== null);
  const totalFootfall = convRows.reduce((s, c) => s + Number(c.footfall), 0);
  const conversionPct = totalFootfall > 0 ? (totalSaleBills / totalFootfall) * 100 : null;
  const salesPerFootfall = totalFootfall > 0 ? totalNetSales / totalFootfall : null;
  const footfallDaysCovered = convRows.length;
  const totalDaysInRange = new Set((daily ?? []).map((d) => `${d.store_id}-${d.bill_date}`)).size;

  // --- Footfall x conversion matrix: per-store trend, this period vs the
  // immediately preceding period of equal length. A store only gets placed
  // on the grid if BOTH periods have footfall entered for it — otherwise
  // there's no trend to compute, and it's listed separately rather than
  // guessed. ---
  type PeriodTotals = { footfall: number; bills: number; net: number };
  function sumByStore(rows: typeof conversion): Map<string, PeriodTotals> {
    const out = new Map<string, PeriodTotals>();
    for (const r of rows ?? []) {
      if (!r.store_id || r.footfall === null) continue;
      const cur = out.get(r.store_id) ?? { footfall: 0, bills: 0, net: 0 };
      cur.footfall += Number(r.footfall);
      cur.bills += Number(r.sale_bills);
      cur.net += Number(r.net_sales);
      out.set(r.store_id, cur);
    }
    return out;
  }
  const curByStore = sumByStore(conversion);
  const prevByStore = sumByStore(prevConversion);

  const matrixEntries: MatrixEntry[] = [];
  const matrixInsufficientData: string[] = [];

  for (const storeId of storeNames.keys()) {
    const curr = curByStore.get(storeId);
    const prev = prevByStore.get(storeId);
    if (!curr || !prev || curr.footfall === 0 || prev.footfall === 0) {
      matrixInsufficientData.push(storeNames.get(storeId) ?? storeId);
      continue;
    }
    const convNow = (curr.bills / curr.footfall) * 100;
    const convPrev = (prev.bills / prev.footfall) * 100;
    const footfallChangePct = ((curr.footfall - prev.footfall) / prev.footfall) * 100;
    const conversionChangePts = convNow - convPrev;
    const salesChangePct = prev.net > 0 ? ((curr.net - prev.net) / prev.net) * 100 : null;

    matrixEntries.push({
      storeId,
      name: storeNames.get(storeId) ?? storeId,
      footfallNow: curr.footfall,
      footfallPrev: prev.footfall,
      footfallChangePct,
      conversionNow: convNow,
      conversionPrev: convPrev,
      conversionChangePts,
      salesNow: curr.net,
      salesPrev: prev.net,
      salesChangePct,
      ...assess(footfallChangePct, conversionChangePts, salesChangePct),
    });
  }

  // --- Footfall data completeness (spec §4/§37) — conversion figures above
  // are only as trustworthy as the footfall behind them, so this is shown
  // next to them rather than buried in a separate data-quality page. ---
  const completenessRows = completeness ?? [];
  const expectedStoreDays = completenessRows.length;
  const enteredStoreDays = completenessRows.filter((r) => r.has_footfall).length;
  const completenessPct = expectedStoreDays > 0 ? (enteredStoreDays / expectedStoreDays) * 100 : null;
  const missingToday = completenessRows.filter((r) => r.date === isoDate(today) && !r.has_footfall).length;

  // --- Per-store sales driver analysis + opportunity sizing (spec §14/§18/§19/§32).
  //
  // Two things this deliberately does NOT do:
  //  1. No YOY anywhere — footfall history is seeded test data, not real
  //     counts, so a YOY figure would be arithmetic on invented numbers.
  //     Everything here is period-over-period against the equally-sized
  //     window immediately before the selected range.
  //  2. Traffic and conversion opportunity are NEVER summed (spec §20).
  //     They overlap — fixing traffic at today's conversion, and fixing
  //     conversion at today's traffic, both count the same incremental
  //     bills. `combinedOpportunity` is computed as the single
  //     both-levers-at-benchmark figure, which is what actually bounds the
  //     upside.
  // primaryIssue / recommendation are NOT recomputed here — they come from
  // assess() via matrixEntries, so this table and the matrix above can never
  // disagree about a store.
  const storeDiagnosis = matrixEntries.map((m) => {
    const curr = curByStore.get(m.storeId)!;
    const prev = prevByStore.get(m.storeId)!;
    const atvNow = curr.bills > 0 ? curr.net / curr.bills : 0;
    const atvPrev = prev.bills > 0 ? prev.net / prev.bills : 0;
    const atvChangePct = atvPrev > 0 ? ((atvNow - atvPrev) / atvPrev) * 100 : null;
    const convNow = m.conversionNow;

    // Benchmark = this store's own previous period. Peer/similar-store
    // benchmarking (spec §17/§39) needs store size/age/type attributes that
    // core.stores doesn't carry yet — deliberately not faked with a network
    // average, which would punish a small store for not matching a big one.
    const benchmarkFootfall = prev.footfall;
    const benchmarkConv = (prev.bills / prev.footfall) * 100;

    const trafficGap = Math.max(0, benchmarkFootfall - curr.footfall);
    const trafficOpportunity = trafficGap * (convNow / 100) * atvNow;

    const convGapPts = Math.max(0, benchmarkConv - convNow);
    const conversionOpportunity = curr.footfall * (convGapPts / 100) * atvNow;

    // Both levers at benchmark, minus actual — the non-additive ceiling.
    const combinedOpportunity = Math.max(
      0,
      benchmarkFootfall * (Math.max(convNow, benchmarkConv) / 100) * atvNow - curr.net
    );

    return {
      ...m,
      atvChangePct,
      salesPerVisitor: curr.footfall > 0 ? curr.net / curr.footfall : null,
      nonConverting: curr.footfall - curr.bills,
      trafficOpportunity,
      conversionOpportunity,
      combinedOpportunity,
    };
  });

  // --- Trend chart ---
  const dailyByDate = new Map<string, number>();
  for (const d of daily ?? []) {
    if (!d.bill_date) continue;
    dailyByDate.set(d.bill_date, (dailyByDate.get(d.bill_date) ?? 0) + Number(d.net_sales));
  }
  const trendPoints = [...dailyByDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => ({ label: DAY_LABEL(date), value }));

  // --- Store league ---
  const byStore = new Map<string, { net: number; gross: number; discount: number; bills: number; qty: number }>();
  for (const w of weekRows) {
    if (!w.store_id) continue;
    const cur = byStore.get(w.store_id) ?? { net: 0, gross: 0, discount: 0, bills: 0, qty: 0 };
    cur.net += Number(w.net_sales);
    cur.gross += Number(w.gross_sales);
    cur.discount += Number(w.discount);
    cur.bills += Number(w.sale_bills);
    cur.qty += Number(w.sale_quantity);
    byStore.set(w.store_id, cur);
  }
  const league = [...byStore.entries()]
    .filter(([storeId]) => storesInView.includes(storeId))
    .map(([storeId, v]) => ({
      storeId,
      name: storeNames.get(storeId) ?? storeId,
      net: v.net,
      bills: v.bills,
      qty: v.qty,
      atv: v.bills > 0 ? v.net / v.bills : null,
      upt: v.bills > 0 ? v.qty / v.bills : null,
      discountPct: v.gross > 0 ? (v.discount / v.gross) * 100 : null,
    }))
    .sort((a, b) => b.net - a.net);

  // --- Scheme penetration, by quantity (not line count) ---
  const bySchemeGroup = new Map<string, { qty: number; net: number }>();
  for (const s of schemeDaily ?? []) {
    const key = s.scheme_group ?? "NO SCHEME";
    const cur = bySchemeGroup.get(key) ?? { qty: 0, net: 0 };
    cur.qty += Number(s.quantity ?? 0);
    cur.net += Number(s.net_sales ?? 0);
    bySchemeGroup.set(key, cur);
  }
  const schemeRows = [...bySchemeGroup.entries()].sort(([, a], [, b]) => b.net - a.net);
  const schemeMaxQty = Math.max(...schemeRows.map(([, v]) => v.qty), 1);

  // --- Agent-wise sales — strip the "001 - " / "003 - " branch-code prefix
  // for display (the raw agent_name keeps it, since it's occasionally the
  // only thing distinguishing two agents with the same first name across
  // stores — grouping is on the full raw name plus store, not the cleaned one) ---
  const cleanAgentName = (name: string) => name.replace(/^\d+\s*-\s*/, "").trim();
  const byAgent = new Map<string, { storeId: string; agent: string; bills: number; qty: number; net: number }>();
  for (const a of agentDaily ?? []) {
    if (!a.store_id) continue;
    const rawName = a.agent_name ?? "Unassigned";
    const key = `${a.store_id}::${rawName}`;
    const cur = byAgent.get(key) ?? { storeId: a.store_id, agent: cleanAgentName(rawName), bills: 0, qty: 0, net: 0 };
    cur.bills += Number(a.bills);
    cur.qty += Number(a.quantity);
    cur.net += Number(a.net_sales);
    byAgent.set(key, cur);
  }
  const agentRows = [...byAgent.values()].sort((a, b) => b.net - a.net).slice(0, 12);

  // --- Hour-of-day, business hours only (9am-12am — stores aren't open overnight) ---
  const HOUR_START = 9;
  const HOUR_END = 23;
  const byHour = new Map<number, number>();
  for (const h of hourly ?? []) {
    if (h.bill_hour === null || h.bill_hour < HOUR_START || h.bill_hour > HOUR_END) continue;
    byHour.set(h.bill_hour, (byHour.get(h.bill_hour) ?? 0) + Number(h.net_sales));
  }
  const hourlyPoints = [...byHour.entries()].map(([hour, value]) => ({ hour, value }));

  // --- Extra KPIs + rule-based "what to do about it" suggestions, all
  // computed from data already loaded above (league, schemeRows,
  // storeDiagnosis) — no external AI call, so this is instant and free.
  // Placed above Week-wise sales per the ask: a reader should see "here's
  // what's happening and what to do" before the raw weekly numbers.
  const topStore = league[0] ?? null;
  const bottomStore = league.length > 1 ? league[league.length - 1] : null;
  const totalSchemeQty = schemeRows.reduce((s, [, v]) => s + v.qty, 0);
  const noSchemeQty = schemeRows.find(([k]) => k === "NO SCHEME")?.[1].qty ?? 0;
  const schemePenetrationPct = totalSchemeQty > 0 ? ((totalSchemeQty - noSchemeQty) / totalSchemeQty) * 100 : null;

  const severity: Record<string, number> = { crit: 3, warn: 2, neutral: 1, good: 0 };
  const flaggedStores = [...storeDiagnosis]
    .filter((s) => s.tone === "crit" || s.tone === "warn")
    .sort((a, b) => (severity[b.tone] ?? 0) - (severity[a.tone] ?? 0))
    .slice(0, 3);

  const insights: string[] = [];
  if (wow !== null && wow < -5) {
    insights.push(`Network sales are down ${Math.abs(wow).toFixed(1)}% week-over-week — worth a closer look before next week.`);
  }
  if (discountPct !== null && discountPct > 25) {
    insights.push(`Discount is ${discountPct.toFixed(1)}% of gross sales — check whether markdowns are being used more than planned.`);
  }
  if (schemePenetrationPct !== null && schemePenetrationPct > 60) {
    insights.push(`${schemePenetrationPct.toFixed(0)}% of units sold this period were on a scheme — a heavy reliance on discounting to move stock.`);
  }
  if (topStore && bottomStore && topStore.storeId !== bottomStore.storeId && topStore.net > 0) {
    const gapPct = ((topStore.net - bottomStore.net) / topStore.net) * 100;
    if (gapPct > 40) {
      insights.push(`${topStore.name} is outselling ${bottomStore.name} by ${gapPct.toFixed(0)}% — worth studying what ${topStore.name} is doing differently.`);
    }
  }
  for (const s of flaggedStores) {
    insights.push(`${s.name}: ${s.headline} — ${s.recommendation}.`);
  }

  return (
    <main className="py-6">
      <div className="flex items-baseline justify-between">
        <h1 className="font-serif text-2xl">Executive dashboard</h1>
        <div className="flex items-center gap-2">
          <MultiSelectFilter
            paramName="store"
            options={(stores ?? []).map((s) => s.store_id)}
            labels={Object.fromEntries((stores ?? []).map((s) => [s.store_id, s.store_name]))}
            selected={storeFilters}
            allLabel="All stores"
          />
          <DateRangePicker from={from} to={to} />
        </div>
      </div>

      {actionSummary && (actionSummary.open_count ?? 0) > 0 && (
        <p className="mt-3 border-l-2 border-warn bg-warn-soft px-3 py-2 text-sm text-ink-2">
          {actionSummary.open_count} open action{actionSummary.open_count === 1 ? "" : "s"} in the queue
          {(actionSummary.closed_unmeasured_count ?? 0) > 0
            ? ` · ${actionSummary.closed_unmeasured_count} closed without a measured result`
            : ""}
        </p>
      )}

      <span className="mt-6 block text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Sales</span>
      <div className="mt-2 grid grid-cols-2 gap-px border border-line-soft bg-line-soft sm:grid-cols-3 lg:grid-cols-6">
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

      <span className="mt-6 block text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
        Footfall &amp; growth
      </span>
      <div className="mt-2 grid grid-cols-2 gap-px border border-line-soft bg-line-soft sm:grid-cols-2 lg:grid-cols-4">
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

      <div className="mt-2 grid grid-cols-2 gap-px border border-line-soft bg-line-soft sm:grid-cols-2 lg:grid-cols-4">
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
      <div className="mt-2 grid grid-cols-2 gap-px border border-line-soft bg-line-soft sm:grid-cols-2 lg:grid-cols-4">
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
          <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Store league</span>
          <div className="mt-2 overflow-x-auto border border-line-soft">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line-soft bg-surface-2 text-left text-[10px] uppercase tracking-wide text-ink-3">
                  <th className="px-3 py-2">Store</th>
                  <th className="px-3 py-2 text-right">Net</th>
                  <th className="px-3 py-2 text-right">Bills</th>
                  <th className="px-3 py-2 text-right">Units</th>
                  <th className="px-3 py-2 text-right">ATV</th>
                  <th className="px-3 py-2 text-right">UPT</th>
                  <th className="px-3 py-2 text-right">Disc</th>
                </tr>
              </thead>
              <tbody>
                {league.map((s) => (
                  <tr key={s.storeId} className="border-b border-line-soft last:border-0">
                    <td className="px-3 py-2">{s.name}</td>
                    <td className="px-3 py-2 text-right font-mono">{INR(s.net)}</td>
                    <td className="px-3 py-2 text-right font-mono">{s.bills}</td>
                    <td className="px-3 py-2 text-right font-mono">{s.qty}</td>
                    <td className="px-3 py-2 text-right font-mono">{s.atv !== null ? INR(s.atv) : "—"}</td>
                    <td className="px-3 py-2 text-right font-mono">{s.upt !== null ? s.upt.toFixed(2) : "—"}</td>
                    <td className="px-3 py-2 text-right font-mono">
                      {s.discountPct !== null ? `${s.discountPct.toFixed(1)}%` : "—"}
                    </td>
                  </tr>
                ))}
                {league.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-4 text-center text-sm text-ink-3">
                      No stores with sales in this window.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

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

          <span className="mt-6 block text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
            Agent-wise sales
          </span>
          <div className="mt-2 overflow-x-auto border border-line-soft">
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
                {agentRows.map((v) => (
                  <tr key={`${v.storeId}-${v.agent}`} className="border-b border-line-soft last:border-0">
                    <td className="px-3 py-2">{v.agent}</td>
                    <td className="px-3 py-2 text-ink-3">{storeNames.get(v.storeId) ?? v.storeId}</td>
                    <td className="px-3 py-2 text-right font-mono">{v.bills}</td>
                    <td className="px-3 py-2 text-right font-mono">{v.qty}</td>
                    <td className="px-3 py-2 text-right font-mono">{INR(v.net)}</td>
                    <td className="px-3 py-2 text-right font-mono">{v.bills > 0 ? INR(v.net / v.bills) : "—"}</td>
                  </tr>
                ))}
                {agentRows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-4 text-center text-sm text-ink-3">
                      No agent data in this window.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

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

      {matrixEntries.length > 0 && (
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

      {storeDiagnosis.length > 0 && (
        <div className="mt-8">
          <div className="flex items-baseline justify-between">
            <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
              Store diagnosis &amp; opportunity
            </span>
            <span className="text-[11px] text-ink-3">
              vs {isoDate(prevFrom)} – {isoDate(prevTo)}
            </span>
          </div>
          <div className="mt-2 overflow-x-auto border border-line-soft">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line-soft bg-surface-2 text-left text-[10px] uppercase tracking-wide text-ink-3">
                  <th className="px-3 py-2">Store</th>
                  <th className="px-3 py-2 text-right">Sales Δ</th>
                  <th className="px-3 py-2 text-right">Footfall Δ</th>
                  <th className="px-3 py-2 text-right">Conv</th>
                  <th className="px-3 py-2 text-right">₹/visitor</th>
                  <th className="px-3 py-2">Primary issue</th>
                  <th className="px-3 py-2 text-right">Opportunity</th>
                  <th className="px-3 py-2">Recommended</th>
                </tr>
              </thead>
              <tbody>
                {storeDiagnosis.map((s) => (
                  <tr key={s.storeId} className="border-b border-line-soft last:border-0">
                    <td className="px-3 py-2">{s.name}</td>
                    <td
                      className={`px-3 py-2 text-right font-mono ${
                        s.salesChangePct === null ? "text-ink-3" : s.salesChangePct >= 0 ? "text-good" : "text-crit"
                      }`}
                    >
                      {s.salesChangePct !== null
                        ? `${s.salesChangePct >= 0 ? "+" : ""}${s.salesChangePct.toFixed(1)}%`
                        : "—"}
                    </td>
                    <td
                      className={`px-3 py-2 text-right font-mono ${
                        s.footfallChangePct >= 0 ? "text-good" : "text-crit"
                      }`}
                    >
                      {s.footfallChangePct >= 0 ? "+" : ""}
                      {s.footfallChangePct.toFixed(1)}%
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {s.conversionNow.toFixed(1)}%
                      <span className={`ml-1 text-[11px] ${s.conversionChangePts >= 0 ? "text-good" : "text-crit"}`}>
                        {s.conversionChangePts >= 0 ? "+" : ""}
                        {s.conversionChangePts.toFixed(1)}pp
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {s.salesPerVisitor !== null ? INR(s.salesPerVisitor) : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <Pill tone={s.tone}>{s.headline}</Pill>
                      <div className="mt-0.5 text-[11.5px] text-ink-3">{s.primaryIssue}</div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {s.combinedOpportunity > 0 ? INR(s.combinedOpportunity) : "—"}
                    </td>
                    <td className="px-3 py-2 text-ink-2">{s.recommendation}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
    </main>
  );
}
