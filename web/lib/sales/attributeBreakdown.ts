/**
 * Product-attribute breakdown of Sale data — /sales' "View by" combo
 * (Phase 3, 2026-08-26). Deliberately the SAME mechanism as Sale vs Stock
 * Mix's own attribute combo (lib/replenishment/mixAttributes.ts): a pool of
 * attribute chips, any combination of them selected, the same underlying
 * already-fetched rows re-bucketed client-side by that combination with no
 * server round-trip on switch.
 *
 * This is a PRODUCT-attribute grouping ("how did the SS2026 collection
 * perform"), NOT a calendar grain — it is independent of, and composes with,
 * the Daily/Weekly/Monthly/Yearly toggle PeriodSalesFacetedTable already
 * ships. The date range and store scope come from the page's own
 * searchParams, applied server-side before these rows are ever fetched.
 *
 * Client-safe (no "server-only") — same reason mixAttributes.ts is: the
 * re-bucketing runs in the browser every time the combo changes.
 *
 * ---------------------------------------------------------------------------
 * Metric conventions — matched to sales.vw_ebo_sales_daily (0005), NOT to
 * lib/replenishment/compute.ts
 * ---------------------------------------------------------------------------
 * These two parts of the app genuinely disagree about returns, and the
 * disagreement is deliberate on both sides:
 *
 *   - Replenishment / Sale vs Stock Mix sign-adjust at query time
 *     (`sign = bill_type === "RETURN" ? -1 : 1`), because they are measuring
 *     net demand for a size/color — a returned unit did not sell.
 *   - The EBO sales rollups (sales.vw_ebo_sales_daily and everything built on
 *     it) sum net_amount/gross_amount UNSIGNED across every bill_type and
 *     report `returns_value` as its own separate figure, while restricting
 *     sale_bills / sale_quantity / atv to bill_type = 'SALE'.
 *
 * /sales renders the SECOND convention everywhere else on the page, so this
 * breakdown reproduces it exactly. Summing `net` across every group here
 * therefore reconciles with the page's own Net Sales KPI for the same scope,
 * instead of disagreeing with it by twice the returns value. `returnsValue`
 * is carried per group so the returns are visible rather than merely folded
 * in.
 *
 * Do not "fix" this to sign-adjust without also changing vw_ebo_sales_daily
 * and re-running web/scripts/verify-metrics.mjs — the formulas in
 * lib/sales/aggregate.ts and this file are the ground truth that harness
 * cross-derives the semantic layer's catalogue against.
 */

export type SaleAttributeKey =
  | "season"
  | "seasonCode"
  | "seasonYear"
  | "category"
  | "subcategory"
  | "gender"
  | "sizeGroup"
  | "marketSegment"
  | "shade"
  | "mrp";

/** Chip labels in the "View by" pool — what the attribute MEANS to a user. */
export const SALE_ATTRIBUTE_LABELS: Record<SaleAttributeKey, string> = {
  season: "Season + Year",
  seasonCode: "Season",
  seasonYear: "Season year",
  category: "Category",
  subcategory: "Subcategory",
  gender: "Gender",
  sizeGroup: "Size Group",
  marketSegment: "Market Segment",
  shade: "Color",
  mrp: "MRP Range",
};

/** Grid column headers — shorter, since the column sits under a combo label. */
export const SALE_ATTRIBUTE_COLUMN_LABELS: Record<SaleAttributeKey, string> = {
  season: "Season",
  seasonCode: "Season",
  seasonYear: "Year",
  category: "Category",
  subcategory: "Subcategory",
  gender: "Gender",
  sizeGroup: "Size Group",
  marketSegment: "Market Segment",
  shade: "Color",
  mrp: "MRP Range",
};

export const SALE_ATTRIBUTE_KEYS: SaleAttributeKey[] = [
  "season",
  "seasonCode",
  "seasonYear",
  "category",
  "subcategory",
  "gender",
  "sizeGroup",
  "marketSegment",
  "shade",
  "mrp",
];

/** The combo the section opens on — the headline ask, "Season + Year". */
export const DEFAULT_SALE_ATTRIBUTE_COMBO: SaleAttributeKey[] = ["season"];

export const DEFAULT_MRP_BUCKET_SIZE = 500;

/**
 * One row of sales.vw_ebo_sale_attribute_lines (0092). Numerics arrive from
 * PostgREST as strings, same as every other view in lib/sales/aggregate.ts —
 * hence the `number | string` unions rather than plain `number`.
 */
export type SaleAttributeLineRow = {
  store_id: string | null;
  bill_date: string | null;
  bill_no: string | null;
  bill_type: string | null;
  total_quantity: number | string | null;
  gross_amount: number | string | null;
  net_amount: number | string | null;
  season: string | null;
  market_segment: string | null;
  category: string | null;
  subcategory: string | null;
  gender: string | null;
  size_group: string | null;
  shade_name: string | null;
  mrp: number | string | null;
};

export type SaleAttributeRow = {
  /**
   * One value per attribute in the combo, same order — a combo of
   * [season, gender] produces ["SS2026", "FEMALE"], rendered as two leading
   * grid columns rather than one joined string, so each stays independently
   * sortable. Same shape (and same reasoning) as mixAttributes.ts's
   * AttributeMixRow.values.
   */
  values: string[];
  net: number;
  gross: number;
  discount: number;
  discountPct: number | null;
  bills: number;
  qty: number;
  atv: number | null;
  upt: number | null;
  returnsValue: number;
  /** This group's share of the scope's total net sales, 0-100. */
  netSharePct: number;
};

const UNCLASSIFIED = "—";

const numOf = (v: number | string | null | undefined): number => {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : 0;
};

const orDash = (v: string | null | undefined): string => {
  const t = (v ?? "").trim();
  return t === "" ? UNCLASSIFIED : t;
};

/**
 * Season values arrive as a single combined token — "SS2024", "AW2026" (0030
 * verified real values straight off the ERP's Sale report). That is already
 * season+year, which is why mixAttributes.ts labels its own `season` chip
 * "Season + Year". Splitting it here is what lets a user ask the OTHER
 * question the combined token can't answer on its own — "how does Summer do
 * across every year" — without needing a second column in the source data.
 *
 * Anything that doesn't match the <letters><digits> shape keeps its whole
 * value as the code and has no year, rather than being silently dropped or
 * guessed at.
 */
const SEASON_TOKEN = /^([A-Za-z]+)\s*[-/ ]?\s*(\d{2,4})$/;

export function seasonCodeOf(season: string | null | undefined): string {
  const raw = (season ?? "").trim();
  if (raw === "") return UNCLASSIFIED;
  const m = SEASON_TOKEN.exec(raw);
  return (m?.[1] ?? raw).toUpperCase();
}

export function seasonYearOf(season: string | null | undefined): string {
  const raw = (season ?? "").trim();
  if (raw === "") return UNCLASSIFIED;
  const m = SEASON_TOKEN.exec(raw);
  const digits = m?.[2];
  if (!digits) return UNCLASSIFIED;
  // "24" and "2024" are the same year — normalise two-digit forms rather
  // than letting them bucket separately from their four-digit twins.
  return digits.length === 2 ? `20${digits}` : digits;
}

/** MRP bucket label — same formula and same "Unclassified" wording as mixAttributes.ts. */
export function mrpBucketLabel(mrp: number | null, bucketSize: number): string {
  if (mrp === null) return "Unclassified (no MRP)";
  const size = bucketSize > 0 ? bucketSize : DEFAULT_MRP_BUCKET_SIZE;
  const lower = Math.floor(mrp / size) * size;
  const upper = lower + size - 1;
  return `₹${lower.toLocaleString("en-IN")}–${upper.toLocaleString("en-IN")}`;
}

export function saleAttributeValueOf(
  row: SaleAttributeLineRow,
  attribute: SaleAttributeKey,
  mrpBucketSize: number
): string {
  switch (attribute) {
    case "season":
      return orDash(row.season);
    case "seasonCode":
      return seasonCodeOf(row.season);
    case "seasonYear":
      return seasonYearOf(row.season);
    case "category":
      return orDash(row.category);
    case "subcategory":
      return orDash(row.subcategory);
    case "gender":
      return orDash(row.gender);
    case "sizeGroup":
      return orDash(row.size_group);
    case "marketSegment":
      return orDash(row.market_segment);
    case "shade":
      return orDash(row.shade_name);
    case "mrp": {
      const mrp = numOf(row.mrp);
      return mrpBucketLabel(Number.isFinite(mrp) && mrp > 0 ? mrp : null, mrpBucketSize);
    }
  }
}

// Unlikely to appear inside a real attribute value — used to join composite
// keys without a value's own separator (a shade named "RED/BLUE") colliding
// with the join. Same guard, same character, as mixAttributes.ts.
const KEY_SEP = " ";

/**
 * Re-buckets sale LINES by whichever attribute COMBINATION is selected, and
 * re-derives every ratio from the group's own sums — never by averaging
 * line-level ratios (the same summed-then-divided rule computeLeague and
 * computeSalesTotals already follow for ATV / discount %).
 *
 * `bills` is a DISTINCT count of (store, date, bill_no) SALE bills within the
 * group, not a sum — one bill that contains both a dress and a top is a real
 * bill for BOTH the DRESS and the TOP group. That is the honest answer to
 * "how many bills contained this attribute", and it means the bills column
 * deliberately does NOT sum to the page's total bill count across groups
 * (ATV per group is likewise net-per-bill-containing-it, not a partition of
 * the network's ATV). `net`/`gross`/`qty` DO partition cleanly and do sum.
 */
export function aggregateSalesByAttributes(
  lines: SaleAttributeLineRow[],
  attributes: SaleAttributeKey[],
  mrpBucketSize: number = DEFAULT_MRP_BUCKET_SIZE
): SaleAttributeRow[] {
  if (attributes.length === 0) return [];

  type Bucket = {
    values: string[];
    net: number;
    gross: number;
    saleNet: number;
    returnsValue: number;
    qty: number;
    billKeys: Set<string>;
  };
  const buckets = new Map<string, Bucket>();

  for (const line of lines) {
    const values = attributes.map((a) => saleAttributeValueOf(line, a, mrpBucketSize));
    const key = values.join(KEY_SEP);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { values, net: 0, gross: 0, saleNet: 0, returnsValue: 0, qty: 0, billKeys: new Set() };
      buckets.set(key, bucket);
    }

    const net = numOf(line.net_amount);
    const gross = numOf(line.gross_amount);
    // Unsigned across every bill_type — see this file's header on why /sales
    // follows vw_ebo_sales_daily here rather than compute.ts's signed rule.
    bucket.net += net;
    bucket.gross += gross;

    if (line.bill_type === "SALE") {
      bucket.saleNet += net;
      bucket.qty += numOf(line.total_quantity);
      // Bill grain is (store, date, bill_no) — bill numbers restart each
      // fiscal year and are only unique within a branch, per
      // [[project-bill-number-format]], so bill_no alone would collide.
      bucket.billKeys.add(`${line.store_id ?? ""}${KEY_SEP}${line.bill_date ?? ""}${KEY_SEP}${line.bill_no ?? ""}`);
    } else if (line.bill_type === "RETURN") {
      bucket.returnsValue += net;
    }
  }

  const totalNet = [...buckets.values()].reduce((s, b) => s + b.net, 0);

  const rows: SaleAttributeRow[] = [];
  for (const b of buckets.values()) {
    const bills = b.billKeys.size;
    const discount = b.gross - b.net;
    rows.push({
      values: b.values,
      net: b.net,
      gross: b.gross,
      discount,
      discountPct: b.gross > 0 ? (discount / b.gross) * 100 : null,
      bills,
      qty: b.qty,
      atv: bills > 0 ? b.saleNet / bills : null,
      upt: bills > 0 ? b.qty / bills : null,
      returnsValue: b.returnsValue,
      netSharePct: totalNet > 0 ? (b.net / totalNet) * 100 : 0,
    });
  }

  // Biggest contributor first — the same "what should I look at" ordering
  // computeLeague uses (net desc), rather than an alphabetical attribute
  // order that buries the answer.
  rows.sort((a, b) => b.net - a.net);
  return rows;
}
