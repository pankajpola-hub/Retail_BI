import * as XLSX from "xlsx";
import { cellToNumber, cellToString } from "./common";

/**
 * "Sale Summary" workbook (report_type 'channel_summary', migration 0101,
 * widened to WEEK grain by 0104) — wholesale/distribution-channel sales
 * (agents, distributors, LFS, MBO, ecommerce marketplaces), pre-aggregated
 * to one row per (branch, month, week, party, channel, channel model) by
 * whoever exports it — a genuinely different shape from the bill/line-grain
 * Sale report parseSaleWorkbook.ts reads.
 *
 * Column set changed with 0104 (was `BRANCH NAME, BILL DATE, PARTY NAME,
 * Channel Name, Channel Type, Channel Model, TOTAL QUANTITY, GROSS AMOUNT,
 * NET AMOUNT` — month grain only). The new, current shape:
 * `branch_name_OG, branch_name, bill_week, week_dates, bill_month,
 * party_name, channel_name, channel_type, channel_model, total_quantity,
 * gross_amount, net_amount`. There is no fallback to the old shape — Pankaj
 * confirmed the same upload card is reused for every future month, always in
 * this new format from here on.
 *
 * Four things this parser handles beyond a fixed-shape parser:
 *
 *  1. HEADER ROW IS LOCATED, NOT ASSUMED — found by scanning the first few
 *     rows for one containing every REQUIRED_COLUMNS name (same technique
 *     parseMasterWorkbook.ts uses), so a leading blank/decorative row (as the
 *     old month-grain sample had) doesn't break parsing.
 *
 *  2. "bill_month" IS A MONTH, NOT A DATE — text like "APR 2021" / "December
 *     2024" (month name/abbreviation + year), not a real per-day date.
 *     Parsed to the 1st of that month via parseMonthYearToDate. A cell Excel
 *     already turned into a real Date is also accepted, normalized the same
 *     way.
 *
 *  3. "bill_week" + "week_dates" -> REAL week_start/week_end DATES —
 *     bill_week is a plain "Week N" label that resets every financial year
 *     (only unique paired with bill_month); week_dates is a raw
 *     "startDay-endDay" label that can cross a month boundary (e.g. "30-05"
 *     under bill_month "APR 2026" means 30 March - 5 April 2026 — the
 *     source's own convention is that a boundary-crossing week is filed
 *     under whichever month its END falls in). deriveWeekRange below turns
 *     that into real dates: when startDay > endDay, the week crosses a
 *     boundary and startDay belongs to the month BEFORE bill_month;
 *     otherwise both days are inside bill_month. Verified against this
 *     file's own two real boundary cases (30 Mar - 5 Apr 2026, 31 Aug -
 *     6 Sep 2026).
 *
 *  4. FISCAL-YEAR-BOUNDARY WEEKS ARE MERGED, NOT DEDUPED-BY-DISCARDING — a
 *     week that straddles the boundary can appear as TWO rows under the same
 *     (branch, month, week, party, channel, channel model) key in one
 *     export, one covering each side of the boundary (confirmed live: every
 *     one of the 716 duplicate-key rows in the profiled 44,314-row file was
 *     Week 52 / APR 2026). Pankaj confirmed these are genuinely additive —
 *     "merge this... because the year changes" — not a stale-vs-corrected
 *     pair. mergeDuplicateKeyRows sums total_quantity/gross_amount/
 *     net_amount for any rows sharing a key, so the database only ever sees
 *     one row per key and the upload RPC's plain overwrite-on-conflict stays
 *     idempotent on a later re-upload (never double-adds).
 *
 * WHICH SHEET HAS THE DATA IS NOT POSITIONAL — same findDataSheet technique
 * as before: scan every sheet for the first one whose header matches, rather
 * than trust position or a hardcoded name. This file's real sheet happens to
 * be named "Merged".
 */

export type ParsedChannelSummaryRow = {
  rowNumber: number;
  branchName: string;
  branchNameOg: string | null;
  billMonth: string; // 'YYYY-MM-DD', always the 1st of the month
  billWeek: number | null;
  weekDates: string;
  weekStart: string; // 'YYYY-MM-DD', '' if undeterminable
  weekEnd: string; // 'YYYY-MM-DD', '' if undeterminable
  partyName: string;
  channelName: string;
  channelType: string | null;
  channelModel: string | null;
  totalQuantity: number;
  grossAmount: number;
  netAmount: number;
  error: string | null;
};

const REQUIRED_COLUMNS = [
  "branch_name_OG",
  "branch_name",
  "bill_week",
  "week_dates",
  "bill_month",
  "party_name",
  "channel_name",
  "channel_type",
  "channel_model",
  "total_quantity",
  "gross_amount",
  "net_amount",
];

/** How far down to look for the header row — tolerant of a leading blank decorative row, same as the old format had. */
const MAX_HEADER_SCAN_ROWS = 10;

const MONTH_NAMES: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * "December 2024" / "APR 2021" -> "2024-12-01" / "2021-04-01". Accepts a
 * real Date cell too (normalized to the 1st of its month). Returns null for
 * anything unrecognized — never guesses.
 */
export function parseMonthYearToDate(value: unknown): string | null {
  if (value instanceof Date && !isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = pad2(value.getMonth() + 1);
    return `${y}-${m}-01`;
  }
  const s = cellToString(value);
  if (!s) return null;

  // "December 2024" / "Dec 2024" / "Dec-2024" / "APR 2021"
  const named = s.match(/^([A-Za-z]+)[\s-]+(\d{4})$/);
  if (named) {
    const monthNum = MONTH_NAMES[named[1]!.toLowerCase()];
    if (monthNum) return `${named[2]}-${pad2(monthNum)}-01`;
  }

  // "2024-12" / "2024/12" / "12/2024" / "12-2024" fallbacks, in case a
  // differently-formatted export shows up later.
  const isoLike = s.match(/^(\d{4})[-/](\d{1,2})$/);
  if (isoLike) return `${isoLike[1]}-${pad2(Number(isoLike[2]))}-01`;
  const monthFirst = s.match(/^(\d{1,2})[-/](\d{4})$/);
  if (monthFirst) return `${monthFirst[2]}-${pad2(Number(monthFirst[1]))}-01`;

  return null;
}

/** "Week 14" -> 14. Returns null for anything else — never guesses. */
export function parseBillWeek(value: unknown): number | null {
  const s = cellToString(value);
  if (!s) return null;
  const m = s.match(/^Week\s*(\d{1,2})$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 1 && n <= 53 ? n : null;
}

/**
 * "30-05" + billMonth "2026-04-01" -> { weekStart: "2026-03-30", weekEnd: "2026-04-05" }.
 * "02-08" + billMonth "2026-02-01" -> { weekStart: "2026-02-02", weekEnd: "2026-02-08" }.
 *
 * When startDay > endDay the week crosses a month boundary — the source
 * file's own convention (verified against its two real boundary weeks) is
 * that such a week is filed under the month its END falls in, so startDay
 * belongs to the month BEFORE billMonth. Returns null if week_dates isn't
 * the expected "DD-DD" shape.
 */
export function deriveWeekRange(weekDatesRaw: string, billMonth: string): { weekStart: string; weekEnd: string } | null {
  // Separator varies by which era of the source export a row came from:
  // older rows carry an EN DASH (U+2013, mangled from the export's original
  // encoding) where newer rows use a plain ASCII hyphen — confirmed on the
  // real file (row 1's "30–05" vs. a later row's "15-21"). Both accepted.
  const m = weekDatesRaw.match(/^(\d{1,2})[-–—](\d{1,2})$/);
  if (!m) return null;
  const startDay = Number(m[1]);
  const endDay = Number(m[2]);
  const [yStr, moStr] = billMonth.split("-");
  const y = Number(yStr);
  const mo = Number(moStr); // 1-indexed
  if (!Number.isInteger(y) || !Number.isInteger(mo)) return null;

  if (startDay > endDay) {
    // JS Date rolls a negative/zero month index back into the prior year —
    // Date.UTC(2026, -1, 1) is December 2025, exactly the "month before
    // billMonth" this needs, including across a January -> December rollover.
    const prev = new Date(Date.UTC(y, mo - 2, 1));
    const prevY = prev.getUTCFullYear();
    const prevM = prev.getUTCMonth() + 1;
    return {
      weekStart: `${prevY}-${pad2(prevM)}-${pad2(startDay)}`,
      weekEnd: `${y}-${pad2(mo)}-${pad2(endDay)}`,
    };
  }
  return {
    weekStart: `${y}-${pad2(mo)}-${pad2(startDay)}`,
    weekEnd: `${y}-${pad2(mo)}-${pad2(endDay)}`,
  };
}

function findHeaderRow(data: unknown[][]): { idx: number; index: Map<string, number> } | null {
  for (let i = 0; i < Math.min(data.length, MAX_HEADER_SCAN_ROWS); i++) {
    const row = data[i] ?? [];
    const index = new Map<string, number>();
    row.forEach((cell, colIdx) => {
      const name = cellToString(cell);
      if (name) index.set(name.toUpperCase(), colIdx);
    });
    const hasAll = REQUIRED_COLUMNS.every((name) => index.has(name.toUpperCase()));
    if (hasAll) return { idx: i, index };
  }
  return null;
}

/**
 * Scans every sheet, in workbook order, for the first one whose header row
 * has every REQUIRED_COLUMNS name — finds the data sheet BY SHAPE, not by
 * position or a hardcoded name (this file's real sheet is named "Merged";
 * a future export could use a different name again).
 */
function findDataSheet(
  workbook: XLSX.WorkBook
): { sheetName: string; data: unknown[][]; header: { idx: number; index: Map<string, number> } } | null {
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const data = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, blankrows: false });
    const header = findHeaderRow(data);
    if (header) return { sheetName, data, header };
  }
  return null;
}

/** Natural key this table upserts on (migration 0104) — must match every field the DB's unique constraint covers. */
function naturalKeyOf(r: ParsedChannelSummaryRow): string {
  return [r.branchName, r.billMonth, r.billWeek, r.partyName, r.channelName, r.channelModel].join("");
}

/**
 * Sums total_quantity/gross_amount/net_amount for any ERROR-FREE rows
 * sharing the same natural key, emitting exactly one row per key — see this
 * file's header, point 4. Error rows are never merged (each needs its own
 * visibility in the preview UI) and pass through unchanged.
 *
 * week_dates/weekStart/weekEnd/channelType/branchNameOg for a merged row are
 * taken from whichever group member spans the MOST days — the wider side of
 * a boundary-crossing week is the more descriptive label to show, and this
 * makes no assumption about which occurrence appears first or second in the
 * source file.
 */
export function mergeDuplicateKeyRows(rows: ParsedChannelSummaryRow[]): ParsedChannelSummaryRow[] {
  const groups = new Map<string, ParsedChannelSummaryRow[]>();
  const passthrough: ParsedChannelSummaryRow[] = [];

  for (const r of rows) {
    if (r.error) {
      passthrough.push(r);
      continue;
    }
    const key = naturalKeyOf(r);
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }

  const spanDays = (r: ParsedChannelSummaryRow): number => {
    if (!r.weekStart || !r.weekEnd) return -1;
    return (new Date(`${r.weekEnd}T00:00:00Z`).getTime() - new Date(`${r.weekStart}T00:00:00Z`).getTime()) / 86400000;
  };

  const merged: ParsedChannelSummaryRow[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      merged.push(group[0]!);
      continue;
    }
    const widest = group.reduce((a, b) => (spanDays(b) > spanDays(a) ? b : a));
    const totalQuantity = group.reduce((sum, r) => sum + r.totalQuantity, 0);
    const grossAmount = group.reduce((sum, r) => sum + r.grossAmount, 0);
    const netAmount = group.reduce((sum, r) => sum + r.netAmount, 0);
    merged.push({
      ...widest,
      rowNumber: group[group.length - 1]!.rowNumber,
      totalQuantity,
      grossAmount,
      netAmount,
    });
  }

  return [...merged, ...passthrough];
}

export function parseChannelSummaryWorkbook(buffer: ArrayBuffer): {
  rows: ParsedChannelSummaryRow[];
  sheetName: string;
} {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });

  const found = findDataSheet(workbook);
  if (!found) {
    // Best-effort diagnostic: show what the first sheet's first non-blank row
    // actually contains, so a genuine shape mismatch is easy to debug even
    // though nothing in the workbook matched.
    const firstSheet = workbook.Sheets[workbook.SheetNames[0] ?? ""];
    const firstData = firstSheet
      ? XLSX.utils.sheet_to_json<unknown[]>(firstSheet, { header: 1, defval: null, blankrows: false })
      : [];
    const firstNonEmpty = firstData.slice(0, MAX_HEADER_SCAN_ROWS).find((r) => r && r.some((c) => cellToString(c) !== null));
    const foundHeaders = (firstNonEmpty ?? []).map((c) => cellToString(c)).filter((c): c is string => c !== null);
    throw new Error(
      `No sheet with a recognizable Sale Summary header row found. Looked for: ${REQUIRED_COLUMNS.join(", ")}. ` +
        `Sheets in this file: ${workbook.SheetNames.join(", ")}. Headers read on sheet "${workbook.SheetNames[0] ?? ""}"'s first non-blank row: ${
          foundHeaders.length > 0 ? foundHeaders.join(", ") : "(none)"
        }.`
    );
  }
  const { sheetName, data, header } = found;
  const { idx: headerRowIdx, index } = header;
  const col = (name: string) => index.get(name.toUpperCase())!;

  const rows: ParsedChannelSummaryRow[] = [];
  for (let i = headerRowIdx + 1; i < data.length; i++) {
    const r = data[i];
    if (!r || r.every((c) => c === null || c === "")) continue;

    const branchName = cellToString(r[col("branch_name")]);
    if (!branchName) continue; // blank-branch stray row, same convention as parseSaleWorkbook

    const billMonth = parseMonthYearToDate(r[col("bill_month")]);
    const billWeek = parseBillWeek(r[col("bill_week")]);
    const weekDates = cellToString(r[col("week_dates")]) ?? "";
    const partyName = cellToString(r[col("party_name")]);
    const channelName = cellToString(r[col("channel_name")]);
    const totalQuantity = cellToNumber(r[col("total_quantity")]);
    const grossAmount = cellToNumber(r[col("gross_amount")]);
    const netAmount = cellToNumber(r[col("net_amount")]);

    const weekRange = billMonth && weekDates ? deriveWeekRange(weekDates, billMonth) : null;

    let error: string | null = null;
    if (!billMonth) error = 'Bill month is missing or not a recognizable "Month Year" (e.g. "APR 2021").';
    else if (billWeek === null) error = 'Bill week is missing or not a recognizable "Week N" (e.g. "Week 14").';
    else if (!weekRange) error = 'Week dates is missing or not a recognizable "DD-DD" range (e.g. "30-05").';
    else if (!partyName) error = "Party name is blank.";
    else if (!channelName) error = "Channel name is blank.";
    else if (totalQuantity === null) error = "Total quantity is missing or not numeric.";
    else if (grossAmount === null) error = "Gross amount is missing or not numeric.";
    else if (netAmount === null) error = "Net amount is missing or not numeric.";

    rows.push({
      rowNumber: i + 1,
      branchName,
      branchNameOg: cellToString(r[col("branch_name_OG")]),
      billMonth: billMonth ?? "",
      billWeek,
      weekDates,
      weekStart: weekRange?.weekStart ?? "",
      weekEnd: weekRange?.weekEnd ?? "",
      partyName: partyName ?? "",
      channelName: channelName ?? "",
      channelType: cellToString(r[col("channel_type")]),
      channelModel: cellToString(r[col("channel_model")]),
      totalQuantity: totalQuantity ?? 0,
      grossAmount: grossAmount ?? 0,
      netAmount: netAmount ?? 0,
      error,
    });
  }

  return { rows: mergeDuplicateKeyRows(rows), sheetName };
}
