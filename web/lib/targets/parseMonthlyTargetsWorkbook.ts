import * as XLSX from "xlsx";

export type ParsedTargetRow = {
  rowNumber: number; // 1-based, matching the row a human sees in Excel (header = row 1)
  storeInput: string;
  storeId: string | null;
  storeName: string | null;
  month: string | null; // "YYYY-MM"
  freshTarget: number | null;
  discountedTarget: number | null;
  error: string | null;
};

type StoreRef = { store_id: string; store_name: string };

function parseCellDate(value: unknown): Date | null {
  if (value instanceof Date && !isNaN(value.getTime())) return value;
  if (typeof value === "number") {
    // Excel serial date fallback — shouldn't normally hit this with
    // cellDates:true, but a hand-edited file can carry a raw serial.
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) return null;
    return new Date(parsed.y, parsed.m - 1, parsed.d);
  }
  if (typeof value === "string") {
    const s = value.trim();
    // DD-MM-YYYY or DD/MM/YYYY — the format the template asks for, and the
    // one already used for bill_date elsewhere in this app.
    const m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (m) {
      const [, d, mo, y] = m;
      const date = new Date(Number(y), Number(mo) - 1, Number(d));
      return isNaN(date.getTime()) ? null : date;
    }
    // ISO fallback (YYYY-MM-DD)
    const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (iso) {
      const [, y, mo, d] = iso;
      const date = new Date(Number(y), Number(mo) - 1, Number(d));
      return isNaN(date.getTime()) ? null : date;
    }
  }
  return null;
}

function resolveStore(input: string, stores: StoreRef[]): StoreRef | null {
  const needle = input.trim().toLowerCase();
  return (
    stores.find((s) => s.store_name.toLowerCase() === needle || s.store_id.toLowerCase() === needle) ?? null
  );
}

function parseQty(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value.trim()) : typeof value === "number" ? value : NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
}

/**
 * Assumes the template's exact column order (Store, Date, Fresh target,
 * Discounted target) with a header in row 1 — matches what
 * /api/targets/monthly/template hands out. A hand-reordered file isn't
 * detected here; it just produces per-row errors in the preview, which is
 * an acceptable failure mode for a low-volume admin upload (a handful of
 * store/month rows), not a silent wrong-column read.
 */
export function parseMonthlyTargetsWorkbook(buffer: ArrayBuffer, stores: StoreRef[]): ParsedTargetRow[] {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];
  const sheet = workbook.Sheets[firstSheetName];
  if (!sheet) return [];
  const data = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, blankrows: false });

  const results: ParsedTargetRow[] = [];
  // Row 0 is the header — skip it.
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row || row.every((c) => c === null || c === "")) continue;

    const [storeCell, dateCell, freshCell, discCell] = row;
    const storeInput = storeCell != null ? String(storeCell).trim() : "";
    const store = storeInput ? resolveStore(storeInput, stores) : null;
    const date = parseCellDate(dateCell);
    const freshTarget = parseQty(freshCell);
    const discountedTarget = parseQty(discCell);

    let error: string | null = null;
    if (!storeInput) error = "Store is blank.";
    else if (!store) error = `Store "${storeInput}" doesn't match any onboarded store.`;
    else if (!date) error = "Date is missing or not in DD-MM-YYYY format.";
    else if (freshTarget === null) error = "Fresh target must be a whole number, 0 or more.";
    else if (discountedTarget === null) error = "Discounted target must be a whole number, 0 or more.";

    results.push({
      rowNumber: i + 1,
      storeInput,
      storeId: store?.store_id ?? null,
      storeName: store?.store_name ?? null,
      month: date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}` : null,
      freshTarget,
      discountedTarget,
      error,
    });
  }
  return results;
}
