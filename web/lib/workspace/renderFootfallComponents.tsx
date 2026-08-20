import type { DataClient, QueryChain } from "@/lib/data/client";
import { KpiCard } from "@/components/ui/KpiCard";
import { Pill } from "@/components/ui/Pill";
import { MatrixCell, TrafficSalesCell } from "@/components/ui/FootfallMatrixCells";
import type { DailyRow, WeeklyRow, SchemeDailyRow } from "@/lib/sales/aggregate";
import { computeFootfallInsights, type ConversionRow, type CompletenessRow, type FootfallInsights } from "@/lib/network/footfall";
import { timeAll } from "@/lib/perf/timing";

/**
 * Fourth non-Sales workspace component family (2026-08-20) — the 7
 * `footfall`-category components, all sourced from `/network`'s
 * FootfallSection. Made possible by extracting that section's business
 * logic into lib/network/footfall.ts's computeFootfallInsights() first
 * (same commit): this module runs the SAME 6 queries FootfallSection does,
 * scoped to the workspace's own store/date filter instead of `/network`'s,
 * and calls that same shared function — so a number shown here can never
 * disagree with `/network`.
 *
 * All 7 components share ONE fetch (same pattern as the 6 Sales
 * components) — gated by `needsFootfallData` in page.tsx, same "pay only
 * for what's added" posture as Sales/Stock/Mix/Replenishment.
 */
export type FootfallComponentScope = {
  supabase: DataClient;
  storeIds: string[];
  from: string;
  to: string;
  storeNames: Map<string, string>;
};

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export async function fetchFootfallComponentData(scope: FootfallComponentScope): Promise<FootfallInsights> {
  const { supabase, storeIds, from, to, storeNames } = scope;
  const applyStore = <T extends { eq: (c: string, v: string) => T; in: (c: string, v: string[]) => T }>(q: T): T => {
    if (storeIds.length === 0) return q;
    if (storeIds.length === 1) return q.eq("store_id", storeIds[0]!);
    return q.in("store_id", storeIds);
  };

  const today = new Date();
  // Same period-over-period comparison window `/network` computes for
  // itself (page.tsx: "Previous period, same length, immediately before
  // `from`") — duplicated here as arithmetic only (dates in, dates out),
  // not business logic, so there's nothing for computeFootfallInsights
  // itself to own.
  const periodDays = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1;
  const prevTo = new Date(from);
  prevTo.setDate(prevTo.getDate() - 1);
  const prevFrom = new Date(prevTo);
  prevFrom.setDate(prevFrom.getDate() - (periodDays - 1));
  const weeklyStart = new Date(from);
  weeklyStart.setDate(weeklyStart.getDate() - 7);

  const [{ data: conversion }, { data: prevConversion }, { data: completeness }, { data: daily }, { data: weeks }, { data: schemeDaily }] =
    await timeAll("workspace:footfall-components", [
      applyStore(supabase.schema("ops").from<ConversionRow>("vw_ebo_conversion_daily").select("store_id, bill_date, footfall, sale_bills, net_sales").gte("bill_date", from).lte("bill_date", to) as unknown as QueryChain<ConversionRow>),
      applyStore(supabase.schema("ops").from<ConversionRow>("vw_ebo_conversion_daily").select("store_id, bill_date, footfall, sale_bills, net_sales").gte("bill_date", isoDate(prevFrom)).lte("bill_date", isoDate(prevTo)) as unknown as QueryChain<ConversionRow>),
      applyStore(supabase.schema("ops").from<CompletenessRow>("vw_footfall_completeness").select("store_id, date, has_footfall").gte("date", from).lte("date", to) as unknown as QueryChain<CompletenessRow>),
      applyStore(supabase.schema("sales").from<DailyRow>("vw_ebo_sales_daily").select("*").gte("bill_date", from).lte("bill_date", to).order("bill_date") as unknown as QueryChain<DailyRow>),
      applyStore(supabase.schema("sales").from<WeeklyRow>("vw_ebo_sales_weekly").select("*").gte("week_start", isoDate(weeklyStart)).lte("week_start", to).order("week_start") as unknown as QueryChain<WeeklyRow>),
      applyStore(supabase.schema("sales").from<SchemeDailyRow>("vw_ebo_scheme_daily").select("*").gte("bill_date", from).lte("bill_date", to) as unknown as QueryChain<SchemeDailyRow>),
    ] as const);

  return computeFootfallInsights({ conversion, prevConversion, completeness, daily, weeks, schemeDaily, storeNames, today, from, prevFrom, prevTo });
}

const INR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

export function FootfallKpiGrid({ data }: { data: FootfallInsights }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <KpiCard
        label="Footfall"
        value={data.footfallDaysCovered > 0 ? String(data.totalFootfall) : "—"}
        sub={data.footfallDaysCovered < data.totalDaysInRange ? `${data.footfallDaysCovered}/${data.totalDaysInRange} days entered` : "all days entered"}
      />
      <KpiCard label="Conversion" value={data.conversionPct !== null ? `${data.conversionPct.toFixed(1)}%` : "—"} />
      <KpiCard label="Sales per footfall" value={data.salesPerFootfall !== null ? INR(data.salesPerFootfall) : "—"} />
      <KpiCard label="WOW" value={data.wow !== null ? `${data.wow >= 0 ? "+" : ""}${data.wow.toFixed(1)}%` : "—"} sub={data.wow === null ? "need 2 complete weeks" : "last complete week"} />
    </div>
  );
}

export function FootfallQualityKpiGrid({ data }: { data: FootfallInsights }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <KpiCard label="Non-converting visits" value={data.totalFootfall > 0 ? String(data.totalFootfall - data.totalSaleBills) : "—"} sub="footfall − bills" />
      <KpiCard label="Footfall data completeness" value={data.completenessPct !== null ? `${data.completenessPct.toFixed(0)}%` : "—"} sub={`${data.enteredStoreDays} of ${data.expectedStoreDays} store-days`} />
      <KpiCard label="Missing today" value={String(data.missingToday)} sub={data.missingToday === 0 ? "all stores entered" : "stores not entered"} />
      <KpiCard label="Stores with traffic issues" value={String(data.storeDiagnosis.filter((s) => s.footfallChangePct < 0 && s.tone !== "good").length)} sub="footfall down & flagged" />
    </div>
  );
}

export function NetworkInsightsKpiGrid({ data }: { data: FootfallInsights }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <KpiCard label="Top store" value={data.topStore ? data.topStore.name : "—"} sub={data.topStore ? INR(data.topStore.net) : undefined} />
      <KpiCard label="Weakest store" value={data.bottomStore ? data.bottomStore.name : "—"} sub={data.bottomStore ? INR(data.bottomStore.net) : undefined} />
      <KpiCard label="Scheme penetration" value={data.schemePenetrationPct !== null ? `${data.schemePenetrationPct.toFixed(0)}%` : "—"} sub="units sold on a scheme" />
      <KpiCard label="Stores flagged" value={String(data.flaggedStores.length)} sub="need attention this period" />
    </div>
  );
}

export function SuggestedActions({ data }: { data: FootfallInsights }) {
  if (data.insights.length === 0) {
    return <p className="text-sm text-ink-3">No rule-based insights for this period/scope.</p>;
  }
  return (
    <ul className="space-y-1.5 text-[13px] text-ink-2">
      {data.insights.map((line, i) => (
        <li key={i} className="flex gap-2">
          <span className="text-accent">•</span>
          <span>{line}</span>
        </li>
      ))}
    </ul>
  );
}

function QuadrantGrid({ children, colHeaders, rowHeaders }: { children: React.ReactNode; colHeaders: [string, string]; rowHeaders: [string, string] }) {
  return (
    <div className="overflow-x-auto border border-line-soft">
      <div className="grid min-w-[560px] grid-cols-[90px_1fr_1fr] gap-px bg-line-soft text-[12.5px]">
        <div className="bg-surface-2" />
        <div className="bg-surface-2 px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wide text-ink-3">{colHeaders[0]}</div>
        <div className="bg-surface-2 px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-wide text-ink-3">{colHeaders[1]}</div>
        <div className="flex items-center justify-center bg-surface-2 px-2 text-center text-[10px] font-semibold uppercase tracking-wide text-ink-3">{rowHeaders[0]}</div>
        {children}
      </div>
    </div>
  );
}

export function FootfallConversionMatrix({ data }: { data: FootfallInsights }) {
  if (data.footfallDaysCovered === 0) {
    return (
      <div className="border border-line-soft bg-surface-2 p-4 text-center">
        <Pill tone="neutral">No footfall entered yet</Pill>
        <p className="mt-2 text-[12.5px] text-ink-3">This grid needs daily footfall entry to place any store on it.</p>
      </div>
    );
  }
  return (
    <>
      <QuadrantGrid colHeaders={["Conversion up", "Conversion down"]} rowHeaders={["Footfall up", "Footfall down"]}>
        <MatrixCell quadrant="healthy" entries={data.matrixEntries} />
        <MatrixCell quadrant="conversion_opportunity" entries={data.matrixEntries} />
        <div className="flex items-center justify-center bg-surface-2 px-2 text-center text-[10px] font-semibold uppercase tracking-wide text-ink-3">Footfall down</div>
        <MatrixCell quadrant="marketing_opportunity" entries={data.matrixEntries} />
        <MatrixCell quadrant="critical" entries={data.matrixEntries} />
      </QuadrantGrid>
      {data.matrixInsufficientData.length > 0 && (
        <p className="mt-2 text-[11.5px] text-ink-3">Not placed: {data.matrixInsufficientData.join(", ")}</p>
      )}
    </>
  );
}

export function TrafficSalesMatrix({ data }: { data: FootfallInsights }) {
  if (data.matrixEntries.length === 0) {
    return <p className="text-sm text-ink-3">No stores with a comparable prior period yet.</p>;
  }
  return (
    <QuadrantGrid colHeaders={["Sales up", "Sales down"]} rowHeaders={["Footfall up", "Footfall down"]}>
      <TrafficSalesCell quadrant="growth_engine" entries={data.matrixEntries} />
      <TrafficSalesCell quadrant="efficiency_opportunity" entries={data.matrixEntries} />
      <div className="flex items-center justify-center bg-surface-2 px-2 text-center text-[10px] font-semibold uppercase tracking-wide text-ink-3">Footfall down</div>
      <TrafficSalesCell quadrant="positive_efficiency" entries={data.matrixEntries} />
      <TrafficSalesCell quadrant="traffic_problem" entries={data.matrixEntries} />
    </QuadrantGrid>
  );
}

export function StoreDiagnosisTable({ data }: { data: FootfallInsights }) {
  if (data.storeDiagnosis.length === 0) {
    return <p className="text-sm text-ink-3">No stores with a comparable prior period yet.</p>;
  }
  return (
    <div className="overflow-x-auto overflow-y-auto">
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="border-b border-line-soft bg-surface-2 text-left text-[10px] uppercase tracking-wide text-ink-3">
            <th className="px-2 py-1.5">Store</th>
            <th className="px-2 py-1.5 text-right">Sales Δ</th>
            <th className="px-2 py-1.5 text-right">Footfall Δ</th>
            <th className="px-2 py-1.5 text-right">Conv</th>
            <th className="px-2 py-1.5 text-right">₹/visitor</th>
            <th className="px-2 py-1.5">Primary issue</th>
            <th className="px-2 py-1.5 text-right">Opportunity</th>
          </tr>
        </thead>
        <tbody>
          {data.storeDiagnosis.map((s) => (
            <tr key={s.storeId} className="border-b border-line-soft last:border-0">
              <td className="px-2 py-1.5">{s.name}</td>
              <td className={`px-2 py-1.5 text-right font-mono ${s.salesChangePct === null ? "text-ink-3" : s.salesChangePct >= 0 ? "text-good" : "text-crit"}`}>
                {s.salesChangePct !== null ? `${s.salesChangePct >= 0 ? "+" : ""}${s.salesChangePct.toFixed(1)}%` : "—"}
              </td>
              <td className={`px-2 py-1.5 text-right font-mono ${s.footfallChangePct >= 0 ? "text-good" : "text-crit"}`}>
                {s.footfallChangePct >= 0 ? "+" : ""}
                {s.footfallChangePct.toFixed(1)}%
              </td>
              <td className="px-2 py-1.5 text-right font-mono">{s.conversionNow.toFixed(1)}%</td>
              <td className="px-2 py-1.5 text-right font-mono">{s.salesPerVisitor !== null ? INR(s.salesPerVisitor) : "—"}</td>
              <td className="px-2 py-1.5">
                <Pill tone={s.tone}>{s.headline}</Pill>
                <div className="mt-0.5 text-[11px] text-ink-3">{s.primaryIssue}</div>
              </td>
              <td className="px-2 py-1.5 text-right font-mono">{s.combinedOpportunity > 0 ? INR(s.combinedOpportunity) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const FOOTFALL_COMPONENT_RENDERERS: Record<string, (props: { data: FootfallInsights }) => JSX.Element> = {
  footfall_kpi_grid: FootfallKpiGrid,
  footfall_quality_kpi_grid: FootfallQualityKpiGrid,
  network_insights_kpi_grid: NetworkInsightsKpiGrid,
  suggested_actions: SuggestedActions,
  footfall_conversion_matrix: FootfallConversionMatrix,
  traffic_sales_matrix: TrafficSalesMatrix,
  store_diagnosis_table: StoreDiagnosisTable,
};
