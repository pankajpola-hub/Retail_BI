// Client-safe (no "server-only") — this runs in the browser, recomputed
// whenever the user switches the Sale vs Stock Mix "View by" pill or edits
// the MRP bucket size. lib/replenishment/mix.ts already fetched every
// item_code (barcode) with its attributes and its own sales/stock in scope
// (MixItemRow) — this file just re-buckets those same rows by whichever
// single attribute is selected, so switching pills needs no server
// round-trip.
import { classifyMixGap, type MixStatus } from "./mixShared";
import type { MixItemRow } from "./mix";

export type AttributeKey = "styleColor" | "color" | "size" | "gender" | "season" | "mrp";

export const ATTRIBUTE_LABELS: Record<AttributeKey, string> = {
  styleColor: "Style + Color",
  color: "Color",
  size: "Size",
  gender: "Gender",
  season: "Season + Year",
  mrp: "MRP Range",
};

export const ATTRIBUTE_COLUMN_LABELS: Record<AttributeKey, string> = {
  styleColor: "Style + Color",
  color: "Color",
  size: "Size",
  gender: "Gender",
  season: "Season",
  mrp: "MRP Range",
};

export type AttributeMixRow = {
  label: string;
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

function attributeKeyOf(row: MixItemRow, attribute: AttributeKey, mrpBucketSize: number): string {
  switch (attribute) {
    case "color":
      return row.color || "—";
    case "size":
      return row.size || "—";
    case "gender":
      return row.gender || "—";
    case "season":
      return row.season || "—";
    case "mrp":
      return mrpBucketLabel(row.mrp, mrpBucketSize);
    case "styleColor":
      return `${row.styleNo}::${row.color}`;
  }
}

/**
 * Re-derives Sale Mix % / Stock Mix % / Gap for whichever attribute the
 * caller groups by — always from the GROUP'S OWN summed sales/stock against
 * the scope-wide totals, never by averaging the item-level percentages
 * (same rule the rest of this app follows for ratios like ATV/discount %:
 * summed-then-divided, not averaged).
 */
export function aggregateMixByAttribute(
  itemRows: MixItemRow[],
  attribute: AttributeKey,
  totalSales: number,
  totalStock: number,
  mrpBucketSize: number = DEFAULT_MRP_BUCKET_SIZE
): AttributeMixRow[] {
  const buckets = new Map<string, { sales: number; soh: number; warehouseAvailable: number }>();
  for (const r of itemRows) {
    const key = attributeKeyOf(r, attribute, mrpBucketSize);
    const cur = buckets.get(key) ?? { sales: 0, soh: 0, warehouseAvailable: 0 };
    cur.sales += r.sales;
    cur.soh += r.soh;
    cur.warehouseAvailable += r.warehouseAvailable;
    buckets.set(key, cur);
  }

  const rows: AttributeMixRow[] = [];
  for (const [label, v] of buckets) {
    const saleMixPct = totalSales > 0 ? (v.sales / totalSales) * 100 : 0;
    const stockMixPct = totalStock > 0 ? (Math.max(0, v.soh) / totalStock) * 100 : 0;
    const mixGapPts = saleMixPct - stockMixPct;
    rows.push({
      label,
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
