import * as XLSX from "xlsx";
import { buildHeaderIndex, cellToNumber, cellToString, isTotalRowMarker } from "./common";

export type ParsedStockRow = {
  rowNumber: number; // 1-based, matching what a human sees in Excel
  branchName: string;
  godownName: string | null;
  companyName: string | null;
  season: string | null;
  marketSegment: string | null;
  gender: string | null;
  sizeGroup: string | null;
  subcategory: string | null;
  microSeason: string | null;
  pricelist: string | null;
  itemCode: string;
  additionalItemCode: string | null;
  itemName: string | null;
  shadeName: string | null;
  size: string | null;
  closingStock: number;
  packing: string | null;
  rate: number | null;
  error: string | null;
};

const REQUIRED_COLUMNS = [
  "BRANCH NAME",
  "GODOWN NAME",
  "COMPANY NAME",
  "SEASON",
  "MARKET SEGMENT",
  "GENDER",
  "SIZE GROUP",
  "SUBCATEGORY",
  "MICRO SEASON",
  "PRICELIST",
  "ITEM CODE",
  "ADDITIONAL ITEM CODE",
  "ITEM NAME W/O SHADE",
  "SHADE NAME",
  "SIZE",
  "CLOSING STOCK-1",
  "PACKING",
  "RATE-3",
];

/**
 * "POS CLOSING STOCK REPORT - ITEM WISE". Sheet name "Report" in the real
 * file; row 1 (0-indexed) is a merged title spanning every column, row 2 is
 * the real header. Two summary rows at the bottom ("Branch Wise Totals",
 * "GRAND TOTALS") are excluded — verified live that the sum of
 * CLOSING STOCK-1 across the kept rows equals the file's own GRAND TOTALS
 * value exactly (5368 in the sample file), so this filter isn't silently
 * dropping or double-counting anything.
 */
export function parseStockWorkbook(buffer: ArrayBuffer): { rows: ParsedStockRow[]; sheetName: string } {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const sheetName = workbook.SheetNames.includes("Report") ? "Report" : (workbook.SheetNames[0] ?? "");
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return { rows: [], sheetName: sheetName ?? "" };

  const data = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, blankrows: false });
  // Row 0 = merged title, row 1 = real header (matches the verified real file).
  const headerRowIdx = data[1] && data[1].includes("BRANCH NAME") ? 1 : 0;
  const header = buildHeaderIndex(data[headerRowIdx] ?? [], REQUIRED_COLUMNS);
  const col = (name: string) => header.get(name)!;

  const rows: ParsedStockRow[] = [];
  for (let i = headerRowIdx + 1; i < data.length; i++) {
    const r = data[i];
    if (!r || r.every((c) => c === null || c === "")) continue;

    const branchName = cellToString(r[col("BRANCH NAME")]);
    if (isTotalRowMarker(branchName)) continue; // "Branch Wise Totals" / "GRAND TOTALS"

    const itemCode = cellToString(r[col("ITEM CODE")]);
    const closingStock = cellToNumber(r[col("CLOSING STOCK-1")]);

    let error: string | null = null;
    if (!branchName) error = "Branch name is blank.";
    else if (!itemCode) error = "Item code is blank.";
    else if (closingStock === null) error = "Closing stock is missing or not numeric.";

    rows.push({
      rowNumber: i + 1,
      branchName: branchName ?? "",
      godownName: cellToString(r[col("GODOWN NAME")]),
      companyName: cellToString(r[col("COMPANY NAME")]),
      season: cellToString(r[col("SEASON")]),
      marketSegment: cellToString(r[col("MARKET SEGMENT")]),
      gender: cellToString(r[col("GENDER")]),
      sizeGroup: cellToString(r[col("SIZE GROUP")]),
      subcategory: cellToString(r[col("SUBCATEGORY")]),
      microSeason: cellToString(r[col("MICRO SEASON")]),
      pricelist: cellToString(r[col("PRICELIST")]),
      itemCode: itemCode ?? "",
      additionalItemCode: cellToString(r[col("ADDITIONAL ITEM CODE")]),
      itemName: cellToString(r[col("ITEM NAME W/O SHADE")]),
      shadeName: cellToString(r[col("SHADE NAME")]),
      size: cellToString(r[col("SIZE")]),
      closingStock: closingStock ?? 0,
      packing: cellToString(r[col("PACKING")]),
      rate: cellToNumber(r[col("RATE-3")]),
      error,
    });
  }
  return { rows, sheetName };
}
