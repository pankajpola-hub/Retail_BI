/**
 * Shared pure sales aggregation — extracted verbatim from
 * app/(ho)/network/page.tsx (Phase 1) so the Workspace Builder's
 * dynamically-rendered Sales components (Phase 5) call the SAME functions
 * the Network page does, rather than a second hand-synced copy. Same
 * function, same inputs, same output, in both places — no drift is
 * possible between "Network page's ATV" and "Workspace's ATV" because
 * there is only one ATV calculation, here.
 *
 * Do not change these formulas without updating the Phase 0 business-logic
 * register and re-running the metric verification harness
 * (web/scripts/verify-metrics.mjs) — these formulas are the independent
 * ground truth it cross-derives the semantic layer's catalogue against.
 */

export type DailyRow = { store_id: string | null; bill_date: string | null; net_sales: number | string };
export type WeeklyRow = {
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
// Full-column daily/monthly rows (2026-08-26, date-grain toggle) — richer
// than the narrow `DailyRow` above (which only ever fed the trend chart).
// sales.vw_ebo_sales_daily/vw_ebo_sales_monthly (0005) already compute
// atv/discount_pct/sale_bills/sale_quantity server-side, same formulas the
// weekly view uses — read directly rather than re-derived, for the same
// consistency reason 0050 repointed atv/upt onto the weekly view (see this
// file's own header on why the formulas live in exactly one place).
export type DailyFullRow = {
  store_id: string | null;
  bill_date: string | null;
  sale_bills: number | string;
  gross_sales: number | string;
  discount: number | string;
  net_sales: number | string;
  atv: number | string | null;
  discount_pct: number | string | null;
  sale_quantity: number | string;
};
export type MonthlyRow = {
  store_id: string | null;
  month_start: string | null;
  financial_year: string | null;
  sale_bills: number | string;
  gross_sales: number | string;
  discount: number | string;
  net_sales: number | string;
  atv: number | string | null;
  discount_pct: number | string | null;
  sale_quantity: number | string;
};
export type SchemeDailyRow = { scheme_group: string | null; quantity: number | string | null; net_sales: number | string | null };
export type HourlyRow = { bill_hour: number | null; net_sales: number | string };
export type AgentDailyRow = { store_id: string | null; agent_name: string | null; bills: number | string; quantity: number | string; net_sales: number | string };

export function computeSalesTotals(weeks: WeeklyRow[] | null, from: string) {
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
  for (const w of weekRows.filter((w) => w.is_complete_week && w.week_start)) {
    const key = w.week_start as string;
    completeWeeksByStart.set(key, (completeWeeksByStart.get(key) ?? 0) + Number(w.net_sales));
  }
  const sortedCompleteWeeks = [...completeWeeksByStart.entries()].sort(([a], [b]) => a.localeCompare(b));
  const lastTwo = sortedCompleteWeeks.slice(-2);
  const wow =
    lastTwo.length === 2 && lastTwo[0] && lastTwo[1] && lastTwo[0][1] > 0
      ? ((lastTwo[1][1] - lastTwo[0][1]) / lastTwo[0][1]) * 100
      : null;

  // A store with rows in weekRows but zero actual sales in the selected
  // range (e.g. a discontinued store like Phoenix Palassio outside its
  // active period) doesn't get its own table/league row — an all-zero
  // block is noise, not a real absence-of-data case worth surfacing.
  const storesInView = [...new Set(weekRows.map((w) => w.store_id).filter((s): s is string => !!s))]
    .filter((sid) => weekRows.some((w) => w.store_id === sid && (Number(w.net_sales) > 0 || Number(w.sale_quantity) > 0)))
    .sort();

  return {
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
    wow,
    storesInView,
  };
}

export function computeLeague(weekRows: WeeklyRow[], storesInView: string[], storeNames: Map<string, string>) {
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
  return [...byStore.entries()]
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
}

export function computeSchemeRows(schemeDaily: SchemeDailyRow[] | null) {
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
  const totalSchemeQty = schemeRows.reduce((s, [, v]) => s + v.qty, 0);
  const noSchemeQty = schemeRows.find(([k]) => k === "NO SCHEME")?.[1].qty ?? 0;
  const schemePenetrationPct = totalSchemeQty > 0 ? ((totalSchemeQty - noSchemeQty) / totalSchemeQty) * 100 : null;
  return { schemeRows, schemeMaxQty, totalSchemeQty, noSchemeQty, schemePenetrationPct };
}

/**
 * Top 12 agents by net sales — extracted verbatim from
 * app/(ho)/network/page.tsx's SalesSection (2026-08-20) so the Workspace's
 * agent_sales_table component calls the same function. Strips the
 * "001 - " / "003 - " branch-code prefix for DISPLAY only — grouping stays
 * on the full raw name + store, since two agents can share a first name
 * across stores and the prefix is occasionally the only thing telling them
 * apart.
 */
export function computeAgentRows(agentDaily: AgentDailyRow[] | null) {
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
  return [...byAgent.values()].sort((a, b) => b.net - a.net).slice(0, 12);
}

const DAY_LABEL = (iso: string) =>
  new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short" });

/** Daily net-sales trend points for TrendChart, network-wide. */
export function computeTrendPoints(daily: DailyRow[] | null) {
  const dailyByDate = new Map<string, number>();
  for (const d of daily ?? []) {
    if (!d.bill_date) continue;
    dailyByDate.set(d.bill_date, (dailyByDate.get(d.bill_date) ?? 0) + Number(d.net_sales));
  }
  return [...dailyByDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => ({ label: DAY_LABEL(date), value }));
}

export const HOUR_START = 9;
export const HOUR_END = 23;

/** Hour-of-day net-sales points for HourlyBarChart, business hours only (9am-midnight). */
export function computeHourlyPoints(hourly: HourlyRow[] | null) {
  const byHour = new Map<number, number>();
  for (const h of hourly ?? []) {
    if (h.bill_hour === null || h.bill_hour < HOUR_START || h.bill_hour > HOUR_END) continue;
    byHour.set(h.bill_hour, (byHour.get(h.bill_hour) ?? 0) + Number(h.net_sales));
  }
  return [...byHour.entries()].map(([hour, value]) => ({ hour, value }));
}

export type WeekRow = {
  retailWeek: number;
  weekStart: string;
  net: number;
  qty: number;
  // Added 2026-08-26 (WeeklySalesFacetedTable's richer advanced-filter set)
  // — additive, existing callers (WeeklyRowDrilldown, Workspace's
  // WeeklySalesTable) destructure only net/qty/netChangePct and are
  // unaffected.
  gross: number;
  discount: number;
  bills: number;
  isCompleteWeek: boolean;
  netChangePct: number | null;
  qtyChangePct: number | null;
};

/** One store's (or, storeId=null, the whole network's) week-by-week series with WOW%. */
export function buildWeekSeries(weekRows: WeeklyRow[], storeId: string | null): WeekRow[] {
  const acc = new Map<
    string,
    { retailWeek: number; weekStart: string; net: number; qty: number; gross: number; discount: number; bills: number; isCompleteWeek: boolean }
  >();
  for (const w of weekRows) {
    if (!w.week_start || w.retail_week === null || !w.store_id) continue;
    if (storeId !== null && w.store_id !== storeId) continue;
    const cur =
      acc.get(w.week_start) ??
      { retailWeek: w.retail_week, weekStart: w.week_start, net: 0, qty: 0, gross: 0, discount: 0, bills: 0, isCompleteWeek: w.is_complete_week };
    cur.net += Number(w.net_sales);
    cur.qty += Number(w.sale_quantity);
    cur.gross += Number(w.gross_sales);
    cur.discount += Number(w.discount);
    cur.bills += Number(w.sale_bills);
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

// -----------------------------------------------------------------------------
// Date-grain toggle (2026-08-26) — Daily / Weekly / Monthly / Yearly, one
// common output shape so a single table component can switch between them.
// Weekly stays WeekRow/buildWeekSeries above (unchanged, other callers
// depend on its exact shape); these three cover the other grains.
// -----------------------------------------------------------------------------
export type PeriodRow = {
  periodKey: string; // sortable, unique per period
  periodLabel: string; // short display label, e.g. "26 Aug", "Aug 2026", "FY2026-27"
  rangeLabel: string; // human date range this period spans
  net: number;
  gross: number;
  discount: number;
  discountPct: number | null;
  bills: number;
  qty: number;
  atv: number | null;
  netChangePct: number | null;
  qtyChangePct: number | null;
  isComplete: boolean;
};

const MONTH_LABEL = (iso: string) => new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { month: "short", year: "numeric" });

function periodOverPeriodPct(rows: { net: number; qty: number }[]): { netChangePct: number | null; qtyChangePct: number | null }[] {
  return rows.map((row, i) => {
    const prev = rows[i - 1];
    return {
      netChangePct: prev && prev.net > 0 ? ((row.net - prev.net) / prev.net) * 100 : null,
      qtyChangePct: prev && prev.qty > 0 ? ((row.qty - prev.qty) / prev.qty) * 100 : null,
    };
  });
}

/** One store's (or, storeId=null, network's) day-by-day series with DoD%, from vw_ebo_sales_daily's own already-full rows. */
export function buildDailyPeriodSeries(dailyRows: DailyFullRow[], storeId: string | null, today: string): PeriodRow[] {
  const acc = new Map<string, { bills: number; gross: number; discount: number; net: number; qty: number }>();
  for (const d of dailyRows) {
    if (!d.bill_date || !d.store_id) continue;
    if (storeId !== null && d.store_id !== storeId) continue;
    const cur = acc.get(d.bill_date) ?? { bills: 0, gross: 0, discount: 0, net: 0, qty: 0 };
    cur.bills += Number(d.sale_bills);
    cur.gross += Number(d.gross_sales);
    cur.discount += Number(d.discount);
    cur.net += Number(d.net_sales);
    cur.qty += Number(d.sale_quantity);
    acc.set(d.bill_date, cur);
  }
  const sorted = [...acc.entries()].sort(([a], [b]) => a.localeCompare(b));
  const deltas = periodOverPeriodPct(sorted.map(([, v]) => v));
  return sorted.map(([date, v], i) => ({
    periodKey: date,
    periodLabel: DAY_LABEL(date),
    rangeLabel: DAY_LABEL(date),
    net: v.net,
    gross: v.gross,
    discount: v.discount,
    discountPct: v.gross > 0 ? (v.discount / v.gross) * 100 : null,
    bills: v.bills,
    qty: v.qty,
    atv: v.bills > 0 ? v.net / v.bills : null,
    isComplete: date < today,
    ...deltas[i]!,
  }));
}

/** One store's (or, storeId=null, network's) month-by-month series with MoM%, from vw_ebo_sales_monthly's own already-full rows. */
export function buildMonthlyPeriodSeries(monthlyRows: MonthlyRow[], storeId: string | null, todayMonthStart: string): PeriodRow[] {
  const acc = new Map<string, { bills: number; gross: number; discount: number; net: number; qty: number }>();
  for (const m of monthlyRows) {
    if (!m.month_start || !m.store_id) continue;
    if (storeId !== null && m.store_id !== storeId) continue;
    const cur = acc.get(m.month_start) ?? { bills: 0, gross: 0, discount: 0, net: 0, qty: 0 };
    cur.bills += Number(m.sale_bills);
    cur.gross += Number(m.gross_sales);
    cur.discount += Number(m.discount);
    cur.net += Number(m.net_sales);
    cur.qty += Number(m.sale_quantity);
    acc.set(m.month_start, cur);
  }
  const sorted = [...acc.entries()].sort(([a], [b]) => a.localeCompare(b));
  const deltas = periodOverPeriodPct(sorted.map(([, v]) => v));
  return sorted.map(([monthStart, v], i) => ({
    periodKey: monthStart,
    periodLabel: MONTH_LABEL(monthStart),
    rangeLabel: MONTH_LABEL(monthStart),
    net: v.net,
    gross: v.gross,
    discount: v.discount,
    discountPct: v.gross > 0 ? (v.discount / v.gross) * 100 : null,
    bills: v.bills,
    qty: v.qty,
    atv: v.bills > 0 ? v.net / v.bills : null,
    isComplete: monthStart < todayMonthStart,
    ...deltas[i]!,
  }));
}

/**
 * One store's (or, storeId=null, network's) year-by-year series with YoY%.
 * No dedicated DB view exists for this grain — aggregated here from the
 * already-fetched monthly rows, grouped by financial_year (this app's own
 * Apr-Mar fiscal convention, matching sales.vw_sale_transactions_export's
 * financial_year — not calendar year, which would split a single retail
 * season across two buckets).
 */
export function buildYearlyPeriodSeries(monthlyRows: MonthlyRow[], storeId: string | null, currentFinancialYear: string): PeriodRow[] {
  const acc = new Map<string, { bills: number; gross: number; discount: number; net: number; qty: number }>();
  for (const m of monthlyRows) {
    if (!m.financial_year || !m.store_id) continue;
    if (storeId !== null && m.store_id !== storeId) continue;
    const cur = acc.get(m.financial_year) ?? { bills: 0, gross: 0, discount: 0, net: 0, qty: 0 };
    cur.bills += Number(m.sale_bills);
    cur.gross += Number(m.gross_sales);
    cur.discount += Number(m.discount);
    cur.net += Number(m.net_sales);
    cur.qty += Number(m.sale_quantity);
    acc.set(m.financial_year, cur);
  }
  const sorted = [...acc.entries()].sort(([a], [b]) => a.localeCompare(b));
  const deltas = periodOverPeriodPct(sorted.map(([, v]) => v));
  return sorted.map(([fy, v], i) => ({
    periodKey: fy,
    periodLabel: fy,
    rangeLabel: fy,
    net: v.net,
    gross: v.gross,
    discount: v.discount,
    discountPct: v.gross > 0 ? (v.discount / v.gross) * 100 : null,
    bills: v.bills,
    qty: v.qty,
    atv: v.bills > 0 ? v.net / v.bills : null,
    isComplete: fy < currentFinancialYear,
    ...deltas[i]!,
  }));
}
