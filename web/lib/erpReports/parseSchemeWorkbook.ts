import * as XLSX from "xlsx";
import { cellToString, parseSchemeDiscountPercent } from "./common";

export type ParsedSchemeRow = {
  rowNumber: number;
  itemCode: string;
  schemeName: string | null;
  discountPct: number | null;
  isDiscounted50Plus: boolean;
  error: string | null;
};

/**
 * Sheet "Sheet1" in the real file, header row 1: Barcode, Scheme. No title
 * row (unlike Sale/Stock). Verified live: 12513 non-blank scheme rows out of
 * 12514 data rows, zero duplicate barcodes, and the only real scheme value
 * present is "FLAT 50% OFF".
 */
export function parseSchemeWorkbook(buffer: ArrayBuffer): { rows: ParsedSchemeRow[]; sheetName: string } {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const sheetName = workbook.SheetNames.includes("Sheet1") ? "Sheet1" : (workbook.SheetNames[0] ?? "");
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return { rows: [], sheetName: sheetName ?? "" };

  const data = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, blankrows: false });

  const rows: ParsedSchemeRow[] = [];
  // Row 0 is the header (Barcode, Scheme) — skip it.
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    if (!r || r.every((c) => c === null || c === "")) continue;

    const itemCode = cellToString(r[0]);
    const schemeName = cellToString(r[1]);

    let error: string | null = null;
    if (!itemCode) error = "Barcode is blank.";

    const discountPct = parseSchemeDiscountPercent(schemeName);
    // Fresh/EOSS split per the 50%-of-gross precedent (migration 0023):
    // prefer the parsed percentage when the scheme name yields one; ASSUMED
    // fallback for a scheme name that doesn't parse into a flat percentage
    // (e.g. "BUY 1 GET 1") is "has any non-blank scheme at all" — flagged
    // clearly since this fallback path has no real data to verify it against
    // today (every current scheme is "FLAT 50% OFF").
    const isDiscounted50Plus = discountPct !== null ? discountPct >= 50 : schemeName !== null;

    rows.push({
      rowNumber: i + 1,
      itemCode: itemCode ?? "",
      schemeName,
      discountPct,
      isDiscounted50Plus,
      error,
    });
  }
  return { rows, sheetName };
}
