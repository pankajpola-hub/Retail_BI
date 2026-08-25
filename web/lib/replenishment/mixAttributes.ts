// Client-safe (no "server-only") — this runs in the browser, recomputed
// whenever the user drags attribute chips into the combo bar or edits the
// MRP bucket size. lib/replenishment/mix.ts already fetched every item_code
// (barcode) with its attributes and its own sales/stock in scope
// (MixItemRow) — this file just re-buckets those same rows by whichever
// attribute COMBINATION is selected, so switching never needs a server
// round-trip.
import { classifyMixGap, type MixStatus } from "./mixShared";
import type { MixItemRow } from "./mix";

export type AttributeKey = "color" | "size" | "sizeGroup" | "gender" | "season" | "mrp";

export const ATTRIBUTE_LABELS: Record<AttributeKey, string> = {
  color: "Color",
  size: "Size",
  sizeGroup: "Size Group",
  gender: "Gender",
  season: "Season + Year",
  mrp: "MRP Range",
};

export const ATTRIBUTE_COLUMN_LABELS: Record<AttributeKey, string> = {
  color: "Color",
  size: "Size",
  sizeGroup: "Size Group",
  gender: "Gender",
  season: "Season",
  mrp: "MRP Range",
};

export const ATTRIBUTE_KEYS: AttributeKey[] = ["color", "size", "sizeGroup", "gender", "season", "mrp"];

export type AttributeMixRow = {
  // One value per attribute in `attributes`, same order — a combo of
  // [gender, color] produces values ["FEMALE", "RED"], rendered as two
  // leading grid columns rather than one combined string, so each stays
  // independently sortable.
  values: string[];
  sales: number;
  saleMixPct: number;
  soh: number;
  stockMixPct: number;
  mixGapPts: number;
  status: MixStatus;
  warehouseAvailable: number;
  negativeStock: boolean;
};

const DEFAULT_MRP_BUCKET_SIZE = 500;

// mrp is already stripped of non-positive/invalid values in mix.ts (kept
// null there instead), so the only guard needed here is a sane bucket size.
export function mrpBucketLabel(mrp: number | null, bucketSize: number): string {
  if (mrp === null) return "Unclassified (no MRP)";
  const size = bucketSize > 0 ? bucketSize : DEFAULT_MRP_BUCKET_SIZE;
  const lower = Math.floor(mrp / size) * size;
  const upper = lower + size - 1;
  return `₹${lower.toLocaleString("en-IN")}–${upper.toLocaleString("en-IN")}`;
}

function attributeValueOf(row: MixItemRow, attribute: AttributeKey, mrpBucketSize: number): string {
  switch (attribute) {
    case "color":
      return row.color || "—";
    case "size":
      return row.size || "—";
    case "sizeGroup":
      return row.sizeGroup || "—";
    case "gender":
      return row.gender || "—";
    case "season":
      return row.season || "—";
    case "mrp":
      return mrpBucketLabel(row.mrp, mrpBucketSize);
  }
}

// Unlikely to appear in real attribute values — used to join composite keys
// without a real value's own separator (e.g. a color named "Red/Blue")
// colliding with the join.
const KEY_SEP = "";

/**
 * Re-derives Sale Mix % / Stock Mix % / Gap for whichever attribute
 * COMBINATION the caller groups by (one attribute = the old single-pill
 * behaviour; several = the drag-and-drop combo bar) — always from the
 * GROUP'S OWN summed sales/stock against the scope-wide totals, never by
 * averaging the item-level percentages (same rule the rest of this app
 * follows for ratios like ATV/discount %: summed-then-divided, not
 * averaged).
 */
export function aggregateMixByAttributes(
  itemRows: MixItemRow[],
  attributes: AttributeKey[],
  totalSales: number,
  totalStock: number,
  mrpBucketSize: number = DEFAULT_MRP_BUCKET_SIZE
): AttributeMixRow[] {
  if (attributes.length === 0) return [];

  const buckets = new Map<string, { values: string[]; sales: number; soh: number; warehouseAvailable: number }>();
  for (const r of itemRows) {
    const values = attributes.map((a) => attributeValueOf(r, a, mrpBucketSize));
    const key = values.join(KEY_SEP);
    const cur = buckets.get(key) ?? { values, sales: 0, soh: 0, warehouseAvailable: 0 };
    cur.sales += r.sales;
    cur.soh += r.soh;
    cur.warehouseAvailable += r.warehouseAvailable;
    buckets.set(key, cur);
  }

  const rows: AttributeMixRow[] = [];
  for (const v of buckets.values()) {
    const saleMixPct = totalSales > 0 ? (v.sales / totalSales) * 100 : 0;
    const stockMixPct = totalStock > 0 ? (Math.max(0, v.soh) / totalStock) * 100 : 0;
    const mixGapPts = saleMixPct - stockMixPct;
    rows.push({
      values: v.values,
      sales: v.sales,
      saleMixPct,
      soh: v.soh,
      stockMixPct,
      mixGapPts,
      status: classifyMixGap(mixGapPts),
      warehouseAvailable: v.warehouseAvailable,
      negativeStock: v.soh < 0,
    });
  }

  rows.sort((a, b) => b.mixGapPts - a.mixGapPts);
  return rows;
}
