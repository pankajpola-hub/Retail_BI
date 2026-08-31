import * as XLSX from "xlsx";
import { cellToNumber, cellToString } from "./common";

/**
 * "Sale Summary" workbook (report_type 'channel_summary', migration 0101) —
 * wholesale/distribution-channel sales (agents, distributors, LFS, MBO,
 * ecommerce marketplaces), pre-aggregated to one row per (branch, month,
 * party, channel) by whoever exports it — a genuinely different shape from
 * the bill/line-grain Sale report parseSaleWorkbook.ts reads.
 *
 * Three things this parser handles that the fixed-shape Sale/Stock parsers
 * don't need to:
 *
 *  1. LEADING BLANK ROW — the profiled sample file has its header on ROW 2,
 *     with row 1 blank/decorative. Rather than assume "header is row 1" or
 *     hardcode "row 2", the header row is LOCATED by scanning the first few
 *     rows for one that contains the required column names (same technique
 *     parseMasterWorkbook.ts uses via its MAX_HEADER_SCAN_ROWS, generalized
 *     here to a fixed-header file instead of a fuzzy-alias one).
 *
 *  2. "BILL DATE" IS A MONTH, NOT A DATE — the column is a text string like
 *     "December 2024" (month name + year), not a real per-day date. Parsed
 *     to the 1st of that month (a real `date`) by parseMonthYearToDate
 *     below. A cell Excel already turned into a real Date (cellDates: true
 *     can do this for some locale/format combinations) is also accepted,
 *     normalized to the 1st of ITS month the same way.
 *
 *  3. WHICH SHEET HAS THE DATA IS NOT POSITIONAL — the source workbook grew
 *     a second sheet ("Channels and its linking", a 73-row Channel Model ->
 *     Channel Type -> Channel Name reference table) placed BEFORE the real
 *     8,146-row "Sales data" sheet, so `workbook.SheetNames[0]` silently read
 *     the wrong sheet the moment that reference tab was added — every upload
 *     failed with "no rows" even though the file was well-formed. The fix:
 *     don't trust position OR a hardcoded sheet-name string (a future export
 *     could rename either tab) — scan EVERY sheet in the workbook, in order,
 *     for one whose header row matches REQUIRED_COLUMNS (same header-row
 *     LOCATING technique as point 1, just applied across sheets too, not
 *     only down rows within one sheet), and read the first one that matches.
 *     The Channel Model/Type mapping the linking sheet carries is redundant
 *     with what's already denormalized onto every Sales data row (verified
 *     1:1 in the real file — see migration 0101's header), so that sheet is
 *     never parsed for its own data, only skipped over.
 */

export type ParsedChannelSummaryRow = {
  rowNumber: number;
  branchName: string;
  billMonth: string; // 'YYYY-MM-DD', always the 1st of the month
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
  "BRANCH NAME",
  "BILL DATE",
  "PARTY NAME",
  "Channel Name",
  "Channel Type",
  "Channel Model",
  "TOTAL QUANTITY",
  "GROSS AMOUNT",
  "NET AMOUNT",
];

/** How far down to look for the header row — the profiled sample has one blank decorative row above it. */
const MAX_HEADER_SCAN_ROWS = 10;

const MONTH_NAMES: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * "December 2024" -> "2024-12-01". Accepts a real Date cell too (normalized
 * to the 1st of its month) in case a future export or a hand-edited file
 * lands it as one. Returns null for anything unrecognized — never guesses.
 */
export function parseMonthYearToDate(value: unknown): string | null {
  if (value instanceof Date && !isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    return `${y}-${m}-01`;
  }
  const s = cellToString(value);
  if (!s) return null;

  // "December 2024" / "Dec 2024" / "Dec-2024" / "December-2024"
  const named = s.match(/^([A-Za-z]+)[\s-]+(\d{4})$/);
  if (named) {
    const monthNum = MONTH_NAMES[named[1]!.toLowerCase()];
    if (monthNum) return `${named[2]}-${String(monthNum).padStart(2, "0")}-01`;
  }

  // "2024-12" / "2024/12" / "12/2024" / "12-2024" fallbacks, in case a
  // differently-formatted export shows up later.
  const isoLike = s.match(/^(\d{4})[-/](\d{1,2})$/);
  if (isoLike) return `${isoLike[1]}-${String(Number(isoLike[2])).padStart(2, "0")}-01`;
  const monthFirst = s.match(/^(\d{1,2})[-/](\d{4})$/);
  if (monthFirst) return `${monthFirst[2]}-${String(Number(monthFirst[1])).padStart(2, "0")}-01`;

  return null;
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
 * (located via findHeaderRow, itself tolerant of a leading blank row) has
 * every REQUIRED_COLUMNS name — i.e. finds the sales-data sheet BY SHAPE, not
 * by position or by a hardcoded name. A reference/mapping tab like "Channels
 * and its linking" (no TOTAL QUANTITY / GROSS AMOUNT / NET AMOUNT columns)
 * never matches and is skipped over regardless of where it sits in the
 * workbook. Returns null only if no sheet matches at all.
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

    const branchName = cellToString(r[col("BRANCH NAME")]);
    if (!branchName) continue; // blank-branch stray row, same convention as parseSaleWorkbook

    const billMonth = parseMonthYearToDate(r[col("BILL DATE")]);
    const partyName = cellToString(r[col("PARTY NAME")]);
    const channelName = cellToString(r[col("Channel Name")]);
    const totalQuantity = cellToNumber(r[col("TOTAL QUANTITY")]);
    const grossAmount = cellToNumber(r[col("GROSS AMOUNT")]);
    const netAmount = cellToNumber(r[col("NET AMOUNT")]);

    let error: string | null = null;
    if (!billMonth) error = "Bill date is missing or not a recognizable \"Month Year\" (e.g. \"December 2024\").";
    else if (!partyName) error = "Party name is blank.";
    else if (!channelName) error = "Channel name is blank.";
    else if (totalQuantity === null) error = "Total quantity is missing or not numeric.";
    else if (grossAmount === null) error = "Gross amount is missing or not numeric.";
    else if (netAmount === null) error = "Net amount is missing or not numeric.";

    rows.push({
      rowNumber: i + 1,
      branchName,
      billMonth: billMonth ?? "",
      partyName: partyName ?? "",
      channelName: channelName ?? "",
      channelType: cellToString(r[col("Channel Type")]),
      channelModel: cellToString(r[col("Channel Model")]),
      totalQuantity: totalQuantity ?? 0,
      grossAmount: grossAmount ?? 0,
      netAmount: netAmount ?? 0,
      error,
    });
  }

  return { rows, sheetName };
}
