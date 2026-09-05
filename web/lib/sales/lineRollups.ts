/**
 * Folds sale LINES up into the exact row shapes the pre-aggregated views
 * produce, so the period table's four grain builders can be reused UNCHANGED
 * against an attribute-filtered line set.
 *
 * WHY THIS SHAPE AND NOT A NEW BUILDER: buildDailyPeriodSeries,
 * buildWeekSeries, buildMonthlyPeriodSeries and buildYearlyPeriodSeries in
 * lib/sales/aggregate.ts already encode the period table's whole contract —
 * period labels, prior-period change %, complete-vs-partial flags, the
 * network-total bucket. Re-implementing that against lines would be a second
 * copy of the page's most fiddly arithmetic, free to drift. Instead these
 * functions reproduce only the VIEWS' aggregation (the cheap, well-defined
 * half) and hand the result to the existing builders untouched.
 *
 * The aggregations below are copied from the live view definitions:
 *
 *   vw_ebo_sales_daily (via vw_ebo_bill): net_sales / gross_sales / discount
 *   summed across ALL bill types; sale_bills = count of distinct SALE bills;
 *   sale_quantity = SALE quantity only; atv = SALE net / sale bills;
 *   discount_pct = 100 * discount / gross.
 *
 * Weekly and monthly are the same figures regrouped on the retail calendar
 * columns the line now carries (0103) rather than recomputed from the date —
 * a retail week is not an ISO week and a financial year is not a calendar
 * year, so core.retail_calendar stays the only definition of that mapping.
 *
 * Sign convention is inherited, not applied: RETURN lines are already
 * negative, so all-bill-type sums net returns out on their own.
 */

import type { SaleLineRow } from "./attributeFilter";
import { isEossLine } from "./lineAggregates";
import type { DailyFullRow, WeeklyRow, MonthlyRow } from "./aggregate";

const numOf = (v: number | string | null | undefined): number => {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : 0;
};

const billKeyOf = (l: SaleLineRow) => `${l.store_id ?? ""} ${l.bill_date ?? ""} ${l.bill_no ?? ""}`;

type Bucket = {
  net: number;
  gross: number;
  saleNet: number;
  saleQty: number;
  freshQty: number;
  eossQty: number;
  billKeys: Set<string>;
};

const newBucket = (): Bucket => ({ net: 0, gross: 0, saleNet: 0, saleQty: 0, freshQty: 0, eossQty: 0, billKeys: new Set() });

function accumulate(b: Bucket, l: SaleLineRow) {
  const net = numOf(l.net_amount);
  b.net += net;
  b.gross += numOf(l.gross_amount);
  if (l.bill_type === "SALE") {
    b.saleNet += net;
    const q = numOf(l.total_quantity);
    b.saleQty += q;
    // Classified PER LINE (0058's discount_ratio rule) and only then summed —
    // a bucket whose overall discount is 40% can still be half EOSS units.
    // SALE lines only, same as saleQty; see computeQtySplitFromLines' note on
    // why returns are excluded rather than netted.
    if (isEossLine(l)) b.eossQty += q;
    else b.freshQty += q;
    b.billKeys.add(billKeyOf(l));
  }
}

/** The shared derived fields every grain exposes, from summed parts only. */
function finish(b: Bucket) {
  const bills = b.billKeys.size;
  const discount = b.gross - b.net;
  return {
    sale_bills: bills,
    gross_sales: b.gross,
    discount,
    net_sales: b.net,
    atv: bills > 0 ? b.saleNet / bills : null,
    discount_pct: b.gross > 0 ? (100 * discount) / b.gross : null,
    sale_quantity: b.saleQty,
    fresh_quantity: b.freshQty,
    eoss_quantity: b.eossQty,
  };
}

/**
 * Grouped by (store, bill_date). Note this yields rows only for dates that
 * actually have lines — unlike vw_ebo_sales_daily, which LEFT JOINs a store x
 * calendar spine and so emits explicit zero rows for closed/blank days. That
 * difference is intentional here: an attribute-filtered view of "days DRESSES
 * sold" should not manufacture a zero row for every day in the range, and
 * buildDailyPeriodSeries already handles a sparse series.
 */
export function linesToDailyRows(lines: SaleLineRow[]): DailyFullRow[] {
  const map = new Map<string, { store_id: string | null; bill_date: string | null; b: Bucket }>();
  for (const l of lines) {
    const key = `${l.store_id ?? ""}|${l.bill_date ?? ""}`;
    let e = map.get(key);
    if (!e) {
      e = { store_id: l.store_id, bill_date: l.bill_date, b: newBucket() };
      map.set(key, e);
    }
    accumulate(e.b, l);
  }
  return [...map.values()]
    .map(({ store_id, bill_date, b }) => ({ store_id, bill_date, ...finish(b) }))
    .sort((a, b) => (a.bill_date ?? "").localeCompare(b.bill_date ?? ""));
}

/**
 * Grouped by (store, week_start) off the retail calendar carried on the line.
 *
 * `is_complete_week` is derived rather than read: the weekly view computes it
 * server-side, and there is no such column on a line. A week counts as
 * complete once its last day (week_start + 6) is in the past — the same
 * question the view answers, asked against the caller's `today`.
 */
export function linesToWeeklyRows(lines: SaleLineRow[], today: string): WeeklyRow[] {
  const map = new Map<string, { week_start: string | null; retail_week: number | null; store_id: string | null; b: Bucket }>();
  for (const l of lines) {
    if (!l.week_start) continue;
    const key = `${l.store_id ?? ""}|${l.week_start}`;
    let e = map.get(key);
    if (!e) {
      e = { week_start: l.week_start, retail_week: l.retail_week ?? null, store_id: l.store_id, b: newBucket() };
      map.set(key, e);
    }
    accumulate(e.b, l);
  }
  const addDays = (iso: string, n: number) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  return [...map.values()]
    .map(({ week_start, retail_week, store_id, b }) => {
      const f = finish(b);
      return {
        week_start,
        retail_week,
        store_id,
        net_sales: f.net_sales,
        gross_sales: f.gross_sales,
        discount: f.discount,
        sale_bills: f.sale_bills,
        sale_quantity: f.sale_quantity,
        fresh_quantity: f.fresh_quantity,
        eoss_quantity: f.eoss_quantity,
        is_complete_week: week_start ? addDays(week_start, 6) <= today : false,
      };
    })
    .sort((a, b) => (a.week_start ?? "").localeCompare(b.week_start ?? ""));
}

/** Grouped by (store, month_start), carrying the financial year for the Yearly grain. */
export function linesToMonthlyRows(lines: SaleLineRow[]): MonthlyRow[] {
  const map = new Map<string, { store_id: string | null; month_start: string | null; financial_year: string | null; b: Bucket }>();
  for (const l of lines) {
    if (!l.month_start) continue;
    const key = `${l.store_id ?? ""}|${l.month_start}`;
    let e = map.get(key);
    if (!e) {
      e = { store_id: l.store_id, month_start: l.month_start, financial_year: l.financial_year ?? null, b: newBucket() };
      map.set(key, e);
    }
    accumulate(e.b, l);
  }
  return [...map.values()]
    .map(({ store_id, month_start, financial_year, b }) => ({ store_id, month_start, financial_year, ...finish(b) }))
    .sort((a, b) => (a.month_start ?? "").localeCompare(b.month_start ?? ""));
}
