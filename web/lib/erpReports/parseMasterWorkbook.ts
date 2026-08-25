import * as XLSX from "xlsx";
import { cellToNumber, cellToString, isTotalRowMarker } from "./common";

/**
 * Item-master workbook (report_type 'master', migration 0054) — one row per
 * item_code carrying the product attributes a Logic ERP Sale export does not
 * always include (category, subcategory, gender, season, size group, shade,
 * market segment, pack size, MRP).
 *
 * Deliberately DIFFERENT from the Sale/Stock parsers in one respect: those two
 * key columns by exact header text via buildHeaderIndex(), because their files
 * are a single known ERP report with a verified, stable header row. A master
 * file is not one report — it is whatever list the merchandising team exports
 * or maintains by hand, so its headers genuinely vary ("Item Code" /
 * "ITEM_CODE" / "SKU" / "Style No"). Header matching here is therefore
 * CASE-INSENSITIVE and insensitive to spaces, underscores, hyphens, dots and
 * any other punctuation: a header is normalised to lowercase alphanumerics
 * and matched against the alias sets below.
 *
 * The resolved mapping is returned so the preview can SHOW the user which of
 * their columns became which field — for a format that varies, that is the
 * single most useful thing in the preview.
 */

export type ParsedMasterRow = {
  rowNumber: number; // 1-based, matching what a human sees in Excel
  itemCode: string;
  itemName: string | null;
  shadeName: string | null;
  packSize: string | null;
  category: string | null;
  subcategory: string | null;
  season: string | null;
  marketSegment: string | null;
  gender: string | null;
  sizeGroup: string | null;
  size: string | null;
  mrp: number | null;
  error: string | null; // kept for shape-consistency with the other parsers; always null in the returned set
};

export type MasterField =
  | "itemCode"
  | "itemName"
  | "shadeName"
  | "packSize"
  | "category"
  | "subcategory"
  | "season"
  | "marketSegment"
  | "gender"
  | "sizeGroup"
  | "size"
  | "mrp";

/** field -> the header text in the user's file that mapped to it (null = no column found). */
export type MasterHeaderMapping = Record<MasterField, string | null>;

export type ParsedMasterWorkbook = {
  rows: ParsedMasterRow[]; // deduplicated, item_code present on every row
  sheetName: string;
  headerMapping: MasterHeaderMapping;
  headersFound: string[]; // every non-blank header cell, in file order
  totalRowsRead: number; // data rows examined, excluding header/blank/total rows
  duplicatesCollapsed: number; // rows dropped because a later row repeated the same item_code
  skipped: { rowNumber: number; reason: string }[];
};

/**
 * Alias sets, already normalised (lowercase, alphanumerics only). Sets are
 * mutually disjoint, so a header cell can map to at most one field and the
 * matching order of the columns in the file doesn't matter. First column to
 * claim a field wins — a second "Size" column later in the file is ignored
 * rather than overwriting the first.
 */
// 2026-08-25: `size` used to be one of sizeGroup's aliases — a column
// literally named "Size" in a customer's master file silently landed in
// size_group, and no upload of any completeness could populate an exact
// size at all (raw_logic.item_master had no column for it either, see
// migration 0087). Now genuinely separate fields/aliases: "Size" maps to
// the new `size` field, "Size Group"/"SizeGroup" still maps to sizeGroup.
const FIELD_ALIASES: Record<MasterField, string[]> = {
  itemCode: ["itemcode", "item", "articlecode", "sku", "styleno", "stylecode"],
  itemName: ["itemname", "style", "stylename", "description"],
  shadeName: ["shadename", "shade", "colour", "color"],
  packSize: ["packsize", "pack"],
  category: ["category", "maincategory"],
  subcategory: ["subcategory", "subcat"],
  season: ["season"],
  marketSegment: ["marketsegment", "segment"],
  gender: ["gender"],
  sizeGroup: ["sizegroup"],
  size: ["size"],
  mrp: ["mrp", "price", "retailprice"],
};

const FIELDS = Object.keys(FIELD_ALIASES) as MasterField[];

/** "ITEM_CODE " / "Item-Code" / "item.code" all normalise to "itemcode". */
function normaliseHeader(value: unknown): string {
  const s = cellToString(value);
  if (!s) return "";
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function aliasToField(normalised: string): MasterField | null {
  if (!normalised) return null;
  for (const field of FIELDS) {
    if (FIELD_ALIASES[field].includes(normalised)) return field;
  }
  return null;
}

type ResolvedHeader = {
  columnByField: Partial<Record<MasterField, number>>;
  mapping: MasterHeaderMapping;
  headersFound: string[];
};

function resolveHeaderRow(headerRow: unknown[]): ResolvedHeader {
  const columnByField: Partial<Record<MasterField, number>> = {};
  const mapping = Object.fromEntries(FIELDS.map((f) => [f, null])) as MasterHeaderMapping;
  const headersFound: string[] = [];

  headerRow.forEach((cell, i) => {
    const raw = cellToString(cell);
    if (!raw) return;
    headersFound.push(raw);
    const field = aliasToField(normaliseHeader(cell));
    if (field && columnByField[field] === undefined) {
      columnByField[field] = i;
      mapping[field] = raw;
    }
  });

  return { columnByField, mapping, headersFound };
}

/** How far down to look for the header row — master files sometimes carry a title//blank banner first. */
const MAX_HEADER_SCAN_ROWS = 10;

export function parseMasterWorkbook(buffer: ArrayBuffer): ParsedMasterWorkbook {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const sheetName = workbook.SheetNames[0] ?? "";
  const sheet = workbook.Sheets[sheetName];
  const emptyMapping = Object.fromEntries(FIELDS.map((f) => [f, null])) as MasterHeaderMapping;
  if (!sheet) {
    return {
      rows: [],
      sheetName,
      headerMapping: emptyMapping,
      headersFound: [],
      totalRowsRead: 0,
      duplicatesCollapsed: 0,
      skipped: [],
    };
  }

  const data = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, blankrows: false });

  // Find the header row: the first row within the scan window that yields an
  // item_code column. Never fall back to "column 0 is probably the item code"
  // — guessing by position on a format that varies is exactly how a whole
  // master file silently loads into the wrong columns.
  let headerRowIdx = -1;
  let resolved: ResolvedHeader | null = null;
  for (let i = 0; i < Math.min(data.length, MAX_HEADER_SCAN_ROWS); i++) {
    const candidate = resolveHeaderRow(data[i] ?? []);
    if (candidate.columnByField.itemCode !== undefined) {
      headerRowIdx = i;
      resolved = candidate;
      break;
    }
  }

  if (!resolved || headerRowIdx < 0) {
    // Report the headers actually present so the user can see what we read
    // and rename a column, rather than a bare "bad file".
    const firstNonEmpty = data.slice(0, MAX_HEADER_SCAN_ROWS).find((r) => r && r.some((c) => cellToString(c) !== null));
    const found = (firstNonEmpty ?? []).map((c) => cellToString(c)).filter((c): c is string => c !== null);
    throw new Error(
      `No item code column found. Headers read: ${found.length > 0 ? found.join(", ") : "(none)"}. ` +
        `Rename one column to one of: ${FIELD_ALIASES.itemCode.join(", ")}.`
    );
  }

  const { columnByField, mapping, headersFound } = resolved;
  const cellAt = (row: unknown[], field: MasterField): unknown => {
    const idx = columnByField[field];
    return idx === undefined ? null : row[idx];
  };

  const byItemCode = new Map<string, ParsedMasterRow>();
  const skipped: { rowNumber: number; reason: string }[] = [];
  let totalRowsRead = 0;
  let duplicatesCollapsed = 0;

  for (let i = headerRowIdx + 1; i < data.length; i++) {
    const r = data[i];
    if (!r || r.every((c) => c === null || c === "")) continue;

    const itemCode = cellToString(cellAt(r, "itemCode"));
    if (isTotalRowMarker(itemCode)) continue; // same embedded subtotal rows the other ERP exports carry

    totalRowsRead++;

    if (!itemCode) {
      skipped.push({ rowNumber: i + 1, reason: "Item code is blank." });
      continue;
    }

    const row: ParsedMasterRow = {
      rowNumber: i + 1,
      itemCode,
      itemName: cellToString(cellAt(r, "itemName")),
      shadeName: cellToString(cellAt(r, "shadeName")),
      packSize: cellToString(cellAt(r, "packSize")),
      category: cellToString(cellAt(r, "category")),
      subcategory: cellToString(cellAt(r, "subcategory")),
      season: cellToString(cellAt(r, "season")),
      marketSegment: cellToString(cellAt(r, "marketSegment")),
      gender: cellToString(cellAt(r, "gender")),
      sizeGroup: cellToString(cellAt(r, "sizeGroup")),
      size: cellToString(cellAt(r, "size")),
      // cellToNumber returns null (never NaN) for anything non-numeric.
      mrp: cellToNumber(cellAt(r, "mrp")),
      error: null,
    };

    // Last one wins within the file — a master list that restates an item
    // later in the same sheet means the later line is the current truth.
    if (byItemCode.has(itemCode)) duplicatesCollapsed++;
    byItemCode.set(itemCode, row);
  }

  return {
    rows: [...byItemCode.values()],
    sheetName,
    headerMapping: mapping,
    headersFound,
    totalRowsRead,
    duplicatesCollapsed,
    skipped,
  };
}
