import * as XLSX from "xlsx";
import {
  buildHeaderIndex,
  cellToBillDateText,
  cellToBillTimeText,
  cellToNumber,
  cellToString,
  isTotalRowMarker,
} from "./common";

export type ParsedSaleRow = {
  rowNumber: number;
  branchName: string;
  billDate: string; // 'DD/MM/YYYY' text, matches raw_logic.sales_transactions' existing convention
  billNo: string;
  itemCode: string;
  totalQuantity: number;
  grossAmount: number;
  netAmount: number | null; // null = not on file; every downstream consumer (views, tracker) coalesces to grossAmount, i.e. counts the quantity as a 0%-discount ("Fresh") line rather than dropping it
  agentName: string | null;
  schemeName: string | null;
  schemeGroupName: string | null;
  billTime: string | null;
  // Added 2026-08 (migration 0030) — the FY24-25/25-26/26-27 Sale report
  // exports carry these item-attribute columns per LINE, not just per
  // upload snapshot like raw_logic.stock_snapshot does. Verified present
  // with real values in all three real files (see 0030's header for
  // samples). Capturing them here means a sale line's gender/subcategory/
  // etc. is the value AS OF THAT SALE, not "whatever the most-recently
  // uploaded stock snapshot says today" — a meaningfully different (and
  // more correct for historical reporting) source than the existing
  // stock-snapshot-based lookup other pages use.
  shadeName: string | null;
  packSize: string | null; // header "PACK / SIZE", e.g. "16", "22" — observed as a size/pack code, not a quantity
  category: string | null; // e.g. "APPAREL" — real files only had one distinct value; kept as-is, not assumed stable
  subcategory: string | null;
  season: string | null;
  marketSegment: string | null;
  gender: string | null;
  sizeGroup: string | null;
  mrp: number | null; // header "M.R.P."
  lineSeq: number; // disambiguates true repeat lines — see migration 0024's header
  error: string | null;
};

const REQUIRED_COLUMNS = [
  "BRANCH NAME",
  "BILL DATE",
  "BILL NO.",
  "ITEM CODE",
  "TOTAL QUANTITY",
  "GROSS AMOUNT",
  "NET AMOUNT",
  "AGENT NAME",
  "SCHEME NAME",
  "SCHEME GROUP NAME",
  "BILL TIME",
  // Added 2026-08 (migration 0030) — present in all three real FY files
  // verified so far; if a future export ever drops one of these, this list
  // is what will make that fail loudly in preview rather than silently
  // parse the row without them (see buildHeaderIndex's header comment).
  "SHADE NAME",
  "PACK / SIZE",
  "CATEGORY",
  "SUBCATEGORY",
  "SEASON",
  "MARKET SEGMENT",
  "GENDER",
  "SIZE GROUP",
  "M.R.P.",
];

/**
 * "MARKETING CAMPAIGN PERFORMANCE REPORT". Sheet "Report" in the real file,
 * row 1 (0-indexed) a merged title, row 2 the real header. Excludes the
 * merged title, the two summary rows ("BRANCH WISE TOTALS", "GRAND TOTALS"),
 * and any row with a blank branch name (one such stray row exists in the
 * real file).
 *
 * line_seq: assigned per (branchName, billDate, billNo, itemCode) in the
 * order rows appear in this file — 1 for the first occurrence, 2 for the
 * second, etc. Nine real bill/item combos in the verified sample repeat
 * (same item rung up twice on the same bill); line_seq is what lets the
 * unique constraint on raw_logic.sales_transactions treat those as two
 * legitimate rows while still making a re-upload of the SAME file
 * idempotent (same row order -> same line_seq -> clean upsert).
 */
export function parseSaleWorkbook(buffer: ArrayBuffer): { rows: ParsedSaleRow[]; sheetName: string } {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const sheetName = workbook.SheetNames.includes("Report") ? "Report" : (workbook.SheetNames[0] ?? "");
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return { rows: [], sheetName: sheetName ?? "" };

  const data = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, blankrows: false });
  const headerRowIdx = data[1] && data[1].includes("BRANCH NAME") ? 1 : 0;
  const header = buildHeaderIndex(data[headerRowIdx] ?? [], REQUIRED_COLUMNS);
  const col = (name: string) => header.get(name)!;

  const seqCounter = new Map<string, number>();
  const rows: ParsedSaleRow[] = [];

  for (let i = headerRowIdx + 1; i < data.length; i++) {
    const r = data[i];
    if (!r || r.every((c) => c === null || c === "")) continue;

    const billNo = cellToString(r[col("BILL NO.")]);
    if (isTotalRowMarker(billNo)) continue; // "BRANCH WISE TOTALS" / "GRAND TOTALS"

    const branchName = cellToString(r[col("BRANCH NAME")]);
    if (!branchName) continue; // the one stray blank-branch row in the real file — not a data row

    const billDate = cellToBillDateText(r[col("BILL DATE")]);
    const itemCode = cellToString(r[col("ITEM CODE")]);
    const totalQuantity = cellToNumber(r[col("TOTAL QUANTITY")]);
    const grossAmount = cellToNumber(r[col("GROSS AMOUNT")]);
    const netAmount = cellToNumber(r[col("NET AMOUNT")]);

    // Net amount is deliberately NOT validated here — a missing/non-numeric
    // NET AMOUNT no longer excludes the row. Quantity is still real and still
    // countable for analysis even when the discount value wasn't captured;
    // netAmount stays null (not defaulted to 0 or to grossAmount here) so the
    // DB's own COALESCE(net_amount, gross_amount) can treat it as a 0%-
    // discount "Fresh" line, same as raw_logic.sales_transactions.net_amount
    // being genuinely nullable already.
    let error: string | null = null;
    if (!billNo) error = "Bill number is blank.";
    else if (!billDate) error = "Bill date is missing or not in DD/MM/YYYY format.";
    else if (!itemCode) error = "Item code is blank.";
    else if (totalQuantity === null) error = "Total quantity is missing or not numeric.";
    else if (grossAmount === null) error = "Gross amount is missing or not numeric.";

    const seqKey = `${branchName}|${billDate ?? ""}|${billNo ?? ""}|${itemCode ?? ""}`;
    const lineSeq = (seqCounter.get(seqKey) ?? 0) + 1;
    seqCounter.set(seqKey, lineSeq);

    rows.push({
      rowNumber: i + 1,
      branchName,
      billDate: billDate ?? "",
      billNo: billNo ?? "",
      itemCode: itemCode ?? "",
      totalQuantity: totalQuantity ?? 0,
      grossAmount: grossAmount ?? 0,
      netAmount: netAmount,
      agentName: cellToString(r[col("AGENT NAME")]),
      schemeName: cellToString(r[col("SCHEME NAME")]),
      schemeGroupName: cellToString(r[col("SCHEME GROUP NAME")]),
      shadeName: cellToString(r[col("SHADE NAME")]),
      packSize: cellToString(r[col("PACK / SIZE")]),
      category: cellToString(r[col("CATEGORY")]),
      subcategory: cellToString(r[col("SUBCATEGORY")]),
      season: cellToString(r[col("SEASON")]),
      marketSegment: cellToString(r[col("MARKET SEGMENT")]),
      gender: cellToString(r[col("GENDER")]),
      sizeGroup: cellToString(r[col("SIZE GROUP")]),
      mrp: cellToNumber(r[col("M.R.P.")]),
      billTime: cellToBillTimeText(r[col("BILL TIME")]),
      lineSeq,
      error,
    });
  }
  return { rows, sheetName };
}
