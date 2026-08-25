// Client-safe (no "server-only") — mirrors lib/replenishment/mixAttributes.ts
// exactly (same attribute set, same drag-and-drop combo mechanism), but for
// the Replenishment tab's own "View by" bar rather than Sale vs Stock Mix's.
// Re-buckets lib/replenishment/compute.ts's item-level ReplItemRow[] by
// whichever attribute COMBINATION the user drags into the combo — entirely
// client-side, no server round-trip, same as the Mix version.
//
// Deliberately does NOT surface recommendedQty at this grain — see
// ReplItemRow's own comment in compute.ts: that number is a Style+Color+
// Store-grain OUTPUT of the network allocation loop, not a real per-size/
// per-attribute figure, and splitting it here would mean inventing an
// allocation the engine never actually computed. This view answers "where
// is stock sitting vs where is it selling" (diagnostic), same spirit as
// Sale vs Stock Mix — for "what to move, exactly," the main Recommendations
// grid (Style+Color+Store grain) is the source of truth.
import { attributeValueOf, ATTRIBUTE_LABELS, ATTRIBUTE_COLUMN_LABELS, ATTRIBUTE_KEYS, type AttributeKey } from "./mixAttributes";
import type { ReplItemRow } from "./compute";

export { ATTRIBUTE_LABELS, ATTRIBUTE_COLUMN_LABELS, ATTRIBUTE_KEYS, type AttributeKey };

export type ReplAttributeRow = {
  // One value per attribute in the combo, same order — mirrors
  // AttributeMixRow's own `values` shape.
  values: string[];
  soh: number;
  warehouseAvailable: number;
  sales30d: number;
  dailyDemand: number;
  coverDays: number | null; // null = infinite (stock but no recent sales)
};

const DEFAULT_MRP_BUCKET_SIZE = 500;

// Same KEY_SEP reasoning as mixAttributes.ts: unlikely to appear in a real
// attribute value, used to join composite keys without a printable
// separator colliding with a real value.
const KEY_SEP = "";

export function aggregateReplenishmentByAttributes(
  itemRows: ReplItemRow[],
  attributes: AttributeKey[],
  mrpBucketSize: number = DEFAULT_MRP_BUCKET_SIZE
): ReplAttributeRow[] {
  if (attributes.length === 0) return [];

  const buckets = new Map<string, { values: string[]; soh: number; warehouseAvailable: number; sales30d: number }>();
  for (const r of itemRows) {
    const values = attributes.map((a) => attributeValueOf(r, a, mrpBucketSize));
    const key = values.join(KEY_SEP);
    const cur = buckets.get(key) ?? { values, soh: 0, warehouseAvailable: 0, sales30d: 0 };
    cur.soh += r.soh;
    cur.warehouseAvailable += r.warehouseAvailable;
    cur.sales30d += r.sales30d;
    buckets.set(key, cur);
  }

  const rows: ReplAttributeRow[] = [];
  for (const v of buckets.values()) {
    const dailyDemand = Math.max(0, v.sales30d) / 30;
    const coverDays = dailyDemand > 0 ? v.soh / dailyDemand : v.soh > 0 ? null : 0;
    rows.push({
      values: v.values,
      soh: v.soh,
      warehouseAvailable: v.warehouseAvailable,
      sales30d: v.sales30d,
      dailyDemand,
      coverDays,
    });
  }

  // Highest demand first — the rows most worth looking at, same spirit as
  // AttributeMixGrid sorting by mix gap.
  rows.sort((a, b) => b.sales30d - a.sales30d);
  return rows;
}
