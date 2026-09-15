/**
 * Pure "YYYY-MM" string arithmetic for the /sale-summary month-range filter.
 * Deliberately never routes through a `new Date(...).toISOString()` round
 * trip — that's exactly the class of bug DateRangePicker.tsx's header
 * documents (a local-midnight Date serialized via UTC toISOString() lands a
 * day early in IST). There's no time-of-day here at all to have that bug,
 * by construction: every value is a bare "YYYY-MM" or "YYYY-MM-DD" string,
 * parsed and re-serialized with plain integer math, never a Date object's
 * own timezone-aware getters/setters.
 */

export function currentYm(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** "2025-01" shifted by `delta` months, e.g. shiftMonth("2025-01", -2) -> "2024-11". */
export function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const total = (y as number) * 12 + ((m as number) - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

/** "2025-01" -> "2025-01-01" (first of the month, matching raw_logic.channel_sales_summary.bill_month's grain). */
export function monthToFirstOfMonthDate(ym: string): string {
  return `${ym}-01`;
}

/** "2025-01" -> "2025-02-01" — an exclusive upper bound for a `< nextMonthStart` range query, so the whole of `ym` is included regardless of how many days it has. */
export function monthToExclusiveUpperBound(ym: string): string {
  return `${shiftMonth(ym, 1)}-01`;
}

/** Compares two "YYYY-MM" strings lexicographically, which is safe for this zero-padded shape. */
export function ymLessOrEqual(a: string, b: string): boolean {
  return a <= b;
}

/** "2026-01" -> "FY2025-26", "2026-04" -> "FY2026-27" (April-March financial year). */
export function financialYearOfYm(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return (m as number) >= 4 ? `FY${y}-${String((y as number) + 1).slice(-2)}` : `FY${(y as number) - 1}-${String(y).slice(-2)}`;
}

/** "FY2025-26" -> { fromMonth: "2025-04", toMonth: "2026-03" }. */
export function financialYearRange(fy: string): { fromMonth: string; toMonth: string } {
  const m = fy.match(/^FY(\d{4})-\d{2}$/);
  const startYear = Number(m?.[1]);
  return { fromMonth: `${startYear}-04`, toMonth: `${startYear + 1}-03` };
}

/** The current FY plus the `count - 1` before it, most recent first — e.g. ["FY2026-27", "FY2025-26", "FY2024-25", ...]. */
export function recentFinancialYears(nowYm: string, count: number): string[] {
  const curFy = financialYearOfYm(nowYm);
  const startYear = Number(curFy.match(/^FY(\d{4})/)?.[1]);
  return Array.from({ length: count }, (_, i) => {
    const y = startYear - i;
    return `FY${y}-${String(y + 1).slice(-2)}`;
  });
}
