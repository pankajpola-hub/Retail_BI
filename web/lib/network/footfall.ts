/**
 * Shared pure footfall/conversion/opportunity aggregation — extracted
 * verbatim from app/(ho)/network/page.tsx's FootfallSection (2026-08-20),
 * the same reason lib/sales/aggregate.ts exists: so the Workspace Builder's
 * 7 footfall-family components (renderFootfallComponents.tsx) call the
 * SAME function `/network` itself calls, rather than a second hand-synced
 * copy that could quietly drift. Every formula, threshold and quadrant rule
 * below is a byte-for-byte move, not a rewrite — see that page's own
 * (extensive) inline comments, preserved here, for the reasoning behind
 * each one.
 *
 * Do not change these formulas without also updating the Phase 0
 * business-logic register, same rule lib/sales/aggregate.ts states.
 */
import type { DailyRow, WeeklyRow, SchemeDailyRow } from "@/lib/sales/aggregate";
import { computeSalesTotals, computeLeague, computeSchemeRows } from "@/lib/sales/aggregate";

export type ConversionRow = {
  store_id: string | null;
  bill_date: string;
  footfall: number | null;
  sale_bills: number | string;
  net_sales: number | string;
};
export type CompletenessRow = { store_id: string | null; date: string; has_footfall: boolean };

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export type Quadrant = "healthy" | "conversion_opportunity" | "marketing_opportunity" | "critical";

export type Assessment = {
  quadrant: Quadrant;
  tone: "good" | "warn" | "crit" | "neutral";
  headline: string;
  primaryIssue: string;
  recommendation: string;
};

/**
 * SINGLE source of truth for "how is this store doing". The matrix and the
 * diagnosis table both call this so they can never contradict each other —
 * see the full rationale in the original page.tsx location this was moved
 * from (git history / HANDOFF.md).
 */
export function assess(footfallChangePct: number, conversionChangePts: number, salesChangePct: number | null): Assessment {
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
    return { quadrant, tone: "neutral", headline: "Not enough data", primaryIssue: "—", recommendation: "—" };
  }

  if (salesChangePct >= 0) {
    switch (quadrant) {
      case "healthy":
        return { quadrant, tone: "good", headline: "Healthy growth", primaryIssue: "None — all levers up", recommendation: "Study & replicate" };
      case "conversion_opportunity":
        return { quadrant, tone: "good", headline: "Growing, conversion slipping", primaryIssue: "None — sales up", recommendation: "Watch conversion" };
      case "marketing_opportunity":
        return { quadrant, tone: "good", headline: "Growing on fewer visitors", primaryIssue: "None — sales up", recommendation: "Rebuild traffic to extend" };
      case "critical":
        return { quadrant, tone: "warn", headline: "Sales up on ATV alone", primaryIssue: "ATV carrying growth", recommendation: "Fragile — rebuild traffic" };
    }
  }

  switch (quadrant) {
    case "healthy":
      return { quadrant, tone: "warn", headline: "Levers up, sales down", primaryIssue: "ATV / mix", recommendation: "Category & pricing review" };
    case "conversion_opportunity":
      return { quadrant, tone: "warn", headline: "Conversion opportunity", primaryIssue: "Conversion", recommendation: "Store ops / staffing" };
    case "marketing_opportunity":
      return { quadrant, tone: "warn", headline: "Marketing opportunity", primaryIssue: "Footfall", recommendation: "Marketing support" };
    case "critical":
      return { quadrant, tone: "crit", headline: "Critical", primaryIssue: "Footfall + conversion", recommendation: "Check stock before spending" };
  }
}

export type MatrixEntry = {
  storeId: string;
  name: string;
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

export const QUADRANT_AXES: Record<Quadrant, string> = {
  healthy: "Footfall ↑ · Conversion ↑",
  conversion_opportunity: "Footfall ↑ · Conversion ↓",
  marketing_opportunity: "Footfall ↓ · Conversion ↑",
  critical: "Footfall ↓ · Conversion ↓",
};

export type TrafficSalesQuadrant = "growth_engine" | "efficiency_opportunity" | "positive_efficiency" | "traffic_problem";

export const TRAFFIC_SALES_META: Record<TrafficSalesQuadrant, { label: string; axes: string; meaning: string; tone: "good" | "warn" | "crit" }> = {
  growth_engine: { label: "Growth engine", axes: "Footfall ↑ · Sales ↑", meaning: "More traffic, more money. Find what's working and copy it.", tone: "good" },
  efficiency_opportunity: { label: "Efficiency opportunity", axes: "Footfall ↑ · Sales ↓", meaning: "Traffic is arriving but not converting into revenue — the store floor is the constraint, not marketing.", tone: "warn" },
  positive_efficiency: { label: "Positive efficiency", axes: "Footfall ↓ · Sales ↑", meaning: "Doing more with fewer visitors. Real, but capped — growth stalls once traffic runs out.", tone: "good" },
  traffic_problem: { label: "Traffic problem", axes: "Footfall ↓ · Sales ↓", meaning: "Fewer people, less money. Traffic is the first thing to fix.", tone: "crit" },
};

export function trafficSalesQuadrant(footfallChangePct: number, salesChangePct: number | null): TrafficSalesQuadrant | null {
  if (salesChangePct === null) return null;
  const footfallUp = footfallChangePct >= 0;
  const salesUp = salesChangePct >= 0;
  if (footfallUp && salesUp) return "growth_engine";
  if (footfallUp && !salesUp) return "efficiency_opportunity";
  if (!footfallUp && salesUp) return "positive_efficiency";
  return "traffic_problem";
}

export type StoreDiagnosisRow = MatrixEntry & {
  atvChangePct: number | null;
  salesPerVisitor: number | null;
  nonConverting: number;
  trafficOpportunity: number;
  conversionOpportunity: number;
  combinedOpportunity: number;
};

export type FootfallInsights = {
  totalFootfall: number;
  conversionPct: number | null;
  salesPerFootfall: number | null;
  footfallDaysCovered: number;
  totalDaysInRange: number;
  totalSaleBills: number;
  totalNetSales: number;
  wow: number | null;
  discountPct: number | null;
  matrixEntries: MatrixEntry[];
  matrixInsufficientData: string[];
  completenessPct: number | null;
  expectedStoreDays: number;
  enteredStoreDays: number;
  missingToday: number;
  storeDiagnosis: StoreDiagnosisRow[];
  topStore: ReturnType<typeof computeLeague>[number] | null;
  bottomStore: ReturnType<typeof computeLeague>[number] | null;
  schemePenetrationPct: number | null;
  flaggedStores: StoreDiagnosisRow[];
  insights: string[];
};

/**
 * All 6 raw queries FootfallSection fetches (conversion x2, completeness,
 * daily/weeks/schemeDaily — the latter three deliberately duplicated from
 * SalesSection's own fetch, see that section's header comment on why) go
 * in; every derived KPI/matrix/table/insight it renders comes out. `today`
 * and the period boundaries are passed in rather than computed here so
 * callers control exactly what "now" and "the comparison period" mean.
 */
export function computeFootfallInsights(params: {
  conversion: ConversionRow[] | null;
  prevConversion: ConversionRow[] | null;
  completeness: CompletenessRow[] | null;
  daily: DailyRow[] | null;
  weeks: WeeklyRow[] | null;
  schemeDaily: SchemeDailyRow[] | null;
  storeNames: Map<string, string>;
  today: Date;
  from: string;
  prevFrom: Date;
  prevTo: Date;
}): FootfallInsights {
  const { conversion, prevConversion, completeness, daily, weeks, schemeDaily, storeNames, today, from, prevFrom, prevTo } = params;

  const convRows = (conversion ?? []).filter((c) => c.footfall !== null);
  const totalFootfall = convRows.reduce((s, c) => s + Number(c.footfall), 0);

  const { totalSaleBills, totalNetSales, wow, discountPct, storesInView, weekRows } = computeSalesTotals(weeks, from);
  const conversionPct = totalFootfall > 0 ? (totalSaleBills / totalFootfall) * 100 : null;
  const salesPerFootfall = totalFootfall > 0 ? totalNetSales / totalFootfall : null;
  const footfallDaysCovered = convRows.length;
  const totalDaysInRange = new Set((daily ?? []).map((d) => `${d.store_id}-${d.bill_date}`)).size;

  type PeriodTotals = { footfall: number; bills: number; net: number };
  function sumByStore(rows: ConversionRow[] | null): Map<string, PeriodTotals> {
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

  const completenessRows = completeness ?? [];
  const expectedStoreDays = completenessRows.length;
  const enteredStoreDays = completenessRows.filter((r) => r.has_footfall).length;
  const completenessPct = expectedStoreDays > 0 ? (enteredStoreDays / expectedStoreDays) * 100 : null;
  const missingToday = completenessRows.filter((r) => r.date === isoDate(today) && !r.has_footfall).length;

  const storeDiagnosis: StoreDiagnosisRow[] = matrixEntries.map((m) => {
    const curr = curByStore.get(m.storeId)!;
    const prev = prevByStore.get(m.storeId)!;
    const atvNow = curr.bills > 0 ? curr.net / curr.bills : 0;
    const atvPrev = prev.bills > 0 ? prev.net / prev.bills : 0;
    const atvChangePct = atvPrev > 0 ? ((atvNow - atvPrev) / atvPrev) * 100 : null;
    const convNow = m.conversionNow;

    const benchmarkFootfall = prev.footfall;
    const benchmarkConv = (prev.bills / prev.footfall) * 100;

    const trafficGap = Math.max(0, benchmarkFootfall - curr.footfall);
    const trafficOpportunity = trafficGap * (convNow / 100) * atvNow;

    const convGapPts = Math.max(0, benchmarkConv - convNow);
    const conversionOpportunity = curr.footfall * (convGapPts / 100) * atvNow;

    const combinedOpportunity = Math.max(0, benchmarkFootfall * (Math.max(convNow, benchmarkConv) / 100) * atvNow - curr.net);

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

  const league = computeLeague(weekRows, storesInView, storeNames);
  const { schemePenetrationPct } = computeSchemeRows(schemeDaily);
  const topStore = league[0] ?? null;
  const bottomStore = league.length > 1 ? league[league.length - 1]! : null;

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

  return {
    totalFootfall,
    conversionPct,
    salesPerFootfall,
    footfallDaysCovered,
    totalDaysInRange,
    totalSaleBills,
    totalNetSales,
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
  };
}
