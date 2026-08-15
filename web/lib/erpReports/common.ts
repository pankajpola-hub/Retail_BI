/**
 * Shared parsing helpers for the three Logic ERP report parsers
 * (parseSaleWorkbook, parseStockWorkbook, parseSchemeWorkbook). Follows the
 * same style as lib/targets/parseMonthlyTargetsWorkbook.ts: read with
 * `header: 1` (raw arrays, not object-keyed rows) so summary/total rows and
 * merged title rows can be filtered by position before anything downstream
 * has to reason about them.
 */

export function cellToString(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

export function cellToNumber(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * All three real reports embed their own subtotal rows ("Branch Wise
 * Totals" / "BRANCH WISE TOTALS", "GRAND TOTALS") in whatever column the
 * branch/bill-no happens to land in for that report's layout. Matched
 * case-insensitively since the Stock report capitalizes differently
 * ("Branch Wise Totals") than the Sale report ("BRANCH WISE TOTALS").
 */
const TOTAL_ROW_MARKERS = new Set(["branch wise totals", "grand totals"]);

export function isTotalRowMarker(value: unknown): boolean {
  const s = cellToString(value);
  return s !== null && TOTAL_ROW_MARKERS.has(s.toLowerCase());
}

/**
 * Builds a header-name -> column-index map from a raw header row, so the
 * parsers key columns by name (robust to Logic ERP reordering columns in a
 * future export) rather than hardcoded positions. Throws if any of the
 * required names are missing — a genuinely different report shape should
 * fail loudly in preview, not silently misread columns.
 */
export function buildHeaderIndex(headerRow: unknown[], required: string[]): Map<string, number> {
  const index = new Map<string, number>();
  headerRow.forEach((cell, i) => {
    const name = cellToString(cell);
    if (name) index.set(name.toUpperCase(), i);
  });
  const missing = required.filter((name) => !index.has(name.toUpperCase()));
  if (missing.length > 0) {
    throw new Error(`Missing expected column(s): ${missing.join(", ")}`);
  }
  return index;
}

/** DD/MM/YYYY text (the format every real report exports dates as) -> 'YYYY-MM-DD'. Returns null if unparseable. */
export function parseErpDateToIso(value: unknown): string | null {
  if (value instanceof Date && !isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const s = cellToString(value);
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m as [string, string, string, string];
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

/**
 * Bill date as the exact 'DD/MM/YYYY' text format raw_logic.sales_transactions
 * already stores it in (see migration 0004's header — the view parses this
 * text format with a regex). The real Sale report exports it as plain text
 * already, so this is usually a passthrough; the Date branch exists only in
 * case a future export or a hand-edited file lands it as a real date cell
 * (cellDates:true would otherwise hand back a JS Date, not the string).
 */
export function cellToBillDateText(value: unknown): string | null {
  if (value instanceof Date && !isNaN(value.getTime())) {
    const d = String(value.getDate()).padStart(2, "0");
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const y = value.getFullYear();
    return `${d}/${m}/${y}`;
  }
  return cellToString(value);
}

/**
 * Bill time as 'HH:MM:SS AM/PM' text — the format ops.fn_monthly_fresh_disc_
 * tracker's bill_time_parsed regex (migrations 0029/0032) expects. With
 * `cellDates: true` (used by every parser here), an Excel cell formatted as
 * a time-of-day value comes back from the xlsx library as a real JS Date
 * (epoch-anchored, e.g. 1899-12-30), not a string — cellToString's plain
 * String(v) on a Date produces its full toString() representation (day name,
 * full date, timezone), not a clean time. That garbled text never matches
 * the DB's 'HH:MI:SS AM' regex, so bill_time_parsed silently ends up NULL
 * for every row and any on-screen/exported time looks wrong. This formats
 * the Date's hour/minute/second directly instead of stringifying it, and
 * still passes plain-text cells through unchanged.
 */
export function cellToBillTimeText(value: unknown): string | null {
  if (value instanceof Date && !isNaN(value.getTime())) {
    let h = value.getHours();
    const m = String(value.getMinutes()).padStart(2, "0");
    const s = String(value.getSeconds()).padStart(2, "0");
    const period = h >= 12 ? "PM" : "AM";
    h = h % 12;
    if (h === 0) h = 12;
    return `${String(h).padStart(2, "0")}:${m}:${s} ${period}`;
  }
  return cellToString(value);
}

/**
 * Parses a fixed percentage out of a scheme name where possible, e.g.
 * "FLAT 50% OFF" -> 50, "FLAT 33.33% OFF" -> 33.33. Returns null for
 * anything that doesn't contain a bare "<number>%" — e.g. "BUY 1 GET 1"
 * describes a discount depth that isn't a flat percentage at all, so this
 * deliberately does NOT guess for those; the caller falls back to
 * "has a non-blank scheme" in that case (see raw_logic.scheme_lookup's
 * comment in migration 0024 for why that fallback is flagged as an
 * assumption, not a certainty).
 */
export function parseSchemeDiscountPercent(schemeName: string | null): number | null {
  if (!schemeName) return null;
  const m = schemeName.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!m) return null;
  const pct = Number(m[1]);
  return Number.isFinite(pct) ? pct : null;
}
