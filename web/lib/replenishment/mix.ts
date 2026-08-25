import "server-only";
import { fetchAllRows } from "@/lib/data/client";
import type { DataClient } from "@/lib/data/client";
import { classifyMixGap, MIX_STATUS_META, type MixStatus } from "./mixShared";

// Sale Mix vs Stock Mix — Style No. + Color level. Answers: "is the way
// stock is currently distributed aligned with how customers are actually
// buying this style+color?" Independent from the Replenishment allocation
// engine (lib/replenishment/compute.ts) — this is a diagnostic lens, not
// another allocator; the Replenishment page already does the actual
// warehouse/store transfer math using its own (richer) velocity model. Mix
// Gap here is meant to be read alongside Replenishment, not instead of it.

export { classifyMixGap, MIX_STATUS_META, type MixStatus };

type StoreRow = { store_id: string; store_name: string; branch_name_erp: string };
type StockRow = {
  branch_name: string | null;
  item_code: string;
  item_name: string | null;
  shade_name: string | null;
  size: string | null;
  size_group: string | null;
  gender: string | null;
  season: string | null;
  mrp: number | string | null;
  closing_stock: number;
};
type SaleRow = {
  branch_name: string | null;
  item_code: string;
  bill_date: string;
  total_quantity: number;
  bill_type: string;
  // 0085 — item_master joined directly onto the sale row, independent of
  // whether this item_code has any current stock. See the itemAttrs
  // build-up below for why this matters: most sold items have already
  // sold through and never appear in vw_stock_with_scheme at all.
  item_name: string | null;
  shade_name: string | null;
  season: string | null;
  gender: string | null;
  size_group: string | null;
  size: string | null; // 0087 — item_master's exact size (was missing entirely before)
  mrp: number | string | null;
};

// `??` only replaces null/undefined, not "" — and this app's ERP-sourced
// text columns have, in the past, carried genuine empty strings rather than
// NULL for "not set" (a real bug found 2026-08-25: blank grid cells where
// "—" was expected). Every attribute field below goes through this instead
// of a bare `?? "—"` for that reason.
function orDash(v: string | null | undefined): string {
  return v && v.trim() ? v : "—";
}

export type MixRow = {
  styleNo: string;
  color: string;
  sales: number;
  saleMixPct: number;
  soh: number;
  stockMixPct: number;
  mixGapPts: number;
  status: MixStatus;
  warehouseAvailable: number;
  negativeStock: boolean;
};

// Item-code (barcode) grain — the finest grain the source data has. Style +
// Color rows (MixRow above) are one rollup of this; the attribute-wise
// views (lib/replenishment/mixAttributes.ts — Color / Size / Gender /
// Season+Year / MRP Range) are others, computed client-side from these same
// rows so switching the "View by" pill needs no extra server round-trip.
export type MixItemRow = {
  itemCode: string;
  styleNo: string;
  color: string;
  size: string;
  sizeGroup: string;
  gender: string;
  season: string;
  mrp: number | null;
  sales: number;
  soh: number;
  warehouseAvailable: number;
};

export type SalesPeriodDays = 7 | 30 | 60 | 90;

export async function computeSaleStockMix(
  supabase: DataClient,
  { storeId, salesPeriodDays }: { storeId: string; salesPeriodDays: SalesPeriodDays }
): Promise<{
  storeList: StoreRow[];
  rows: MixRow[];
  itemRows: MixItemRow[];
  totalSales: number;
  totalStock: number;
}> {
  const periodStart = new Date();
  periodStart.setDate(periodStart.getDate() - salesPeriodDays);
  const fromDate = periodStart.toISOString().slice(0, 10);

  // stores/stock/sale are independent — stores is only used AFTER all three
  // resolve (grouping), never as an input filter here. Genuinely parallel;
  // stock and sale each page internally via fetchAllRows above.
  const [{ data: storesData }, stockRows, saleRows] = await Promise.all([
    supabase
      .schema("core")
      .from<StoreRow>("stores")
      .select("store_id, store_name, branch_name_erp")
      .order("store_id"),
    fetchAllRows(() =>
      supabase
        .schema("sales")
        .from<StockRow>("vw_stock_with_scheme")
        .select("branch_name, item_code, item_name, shade_name, size, size_group, gender, season, mrp, closing_stock")
    ),
    fetchAllRows(() =>
      supabase
        .schema("sales")
        .from<SaleRow>("vw_sale_transactions_export")
        .select("branch_name, item_code, bill_date, total_quantity, bill_type, item_name, shade_name, season, gender, size_group, size, mrp")
        .gte("bill_date", fromDate)
    ),
  ]);
  const storeList = (storesData ?? []).filter((s) => s.store_id !== "BO-004");
  const storeBranchToId = new Map(storeList.map((s) => [s.branch_name_erp, s.store_id]));

  // Same style+color grain as Replenishment (lib/replenishment/compute.ts) —
  // never combine colors of the same style (section 1 of the spec). Also
  // carries every other attribute (size, gender, season, mrp) an item_code
  // has, for the attribute-wise views — one lookup built once, reused by
  // both grains below.
  //
  // Built from TWO sources, stock first then sale as a fallback. Both now
  // carry a real exact `size` (0087 added raw_logic.item_master.size — it
  // never existed before, so a sale-only item_code genuinely had no size
  // to read; see that migration's header for the full story, including a
  // master-upload parser bug that had been folding a literal "Size" column
  // into size_group instead). Without the sale-side fallback (0085) at
  // all, any item_code that has fully sold through — closing_stock
  // 0/absent from the current snapshot — never appears in
  // vw_stock_with_scheme, so its attributes were unreachable regardless of
  // item_master's completeness. Confirmed live: ~95% of a sale sample's
  // item_codes weren't in the stock view.
  const itemAttrs = new Map<
    string,
    { styleNo: string; color: string; size: string; sizeGroup: string; gender: string; season: string; mrp: number | null }
  >();
  for (const r of stockRows ?? []) {
    if (!itemAttrs.has(r.item_code)) {
      const mrpNum = r.mrp === null || r.mrp === undefined ? null : Number(r.mrp);
      itemAttrs.set(r.item_code, {
        styleNo: r.item_name ?? r.item_code,
        color: orDash(r.shade_name),
        size: orDash(r.size),
        sizeGroup: orDash(r.size_group),
        gender: orDash(r.gender),
        season: orDash(r.season),
        mrp: mrpNum !== null && Number.isFinite(mrpNum) && mrpNum > 0 ? mrpNum : null,
      });
    }
  }
  for (const r of saleRows ?? []) {
    if (!itemAttrs.has(r.item_code)) {
      const mrpNum = r.mrp === null || r.mrp === undefined ? null : Number(r.mrp);
      itemAttrs.set(r.item_code, {
        styleNo: r.item_name ?? r.item_code,
        color: orDash(r.shade_name),
        size: orDash(r.size), // 0087 — item_master's own size, joined onto the sale row directly
        sizeGroup: orDash(r.size_group),
        gender: orDash(r.gender),
        season: orDash(r.season),
        mrp: mrpNum !== null && Number.isFinite(mrpNum) && mrpNum > 0 ? mrpNum : null,
      });
    }
  }
  function styleColorKeyOf(itemCode: string): { key: string; styleNo: string; color: string } {
    const meta = itemAttrs.get(itemCode) ?? { styleNo: itemCode, color: "—" };
    return { key: `${meta.styleNo}::${meta.color}`, styleNo: meta.styleNo, color: meta.color };
  }

  // Stock Mix is built from STORE stock only (not warehouse) — the question
  // this feature answers is "does what's on the shop floor match how
  // customers are buying," so warehouse bulk stock (tracked separately
  // below for the section-8 availability check) would distort it if mixed
  // in. Section 7: when storeId is set, only that store's own SOH/sales
  // count — another store's numbers must never leak into a per-store view.
  //
  // Two parallel aggregations from the same rows: by style+color key (the
  // existing default view, unchanged) and by item_code (the finer grain the
  // attribute-wise views roll up from instead).
  const stockByKey = new Map<string, { styleNo: string; color: string; qty: number }>();
  const warehouseByKey = new Map<string, number>();
  const stockByItem = new Map<string, number>();
  const warehouseByItem = new Map<string, number>();
  for (const r of stockRows ?? []) {
    if (!r.branch_name) continue;
    const { key, styleNo, color } = styleColorKeyOf(r.item_code);
    const rowStoreId = storeBranchToId.get(r.branch_name);
    if (!rowStoreId) {
      warehouseByKey.set(key, (warehouseByKey.get(key) ?? 0) + Number(r.closing_stock));
      warehouseByItem.set(r.item_code, (warehouseByItem.get(r.item_code) ?? 0) + Number(r.closing_stock));
      continue;
    }
    if (storeId && rowStoreId !== storeId) continue;
    const cur = stockByKey.get(key) ?? { styleNo, color, qty: 0 };
    cur.qty += Number(r.closing_stock);
    stockByKey.set(key, cur);
    stockByItem.set(r.item_code, (stockByItem.get(r.item_code) ?? 0) + Number(r.closing_stock));
  }

  // Sales Mix: net units (SALE - RETURN), OTHER (cancelled/unclassified)
  // excluded entirely so cancellations never inflate the denominator either
  // (section 12 — "returns and cancelled orders should not inflate sales
  // quantity").
  const salesByKey = new Map<string, { styleNo: string; color: string; qty: number }>();
  const salesByItem = new Map<string, number>();
  for (const r of saleRows ?? []) {
    if (!r.branch_name) continue;
    const rowStoreId = storeBranchToId.get(r.branch_name);
    if (!rowStoreId) continue; // warehouse/office channel rows aren't store demand
    if (storeId && rowStoreId !== storeId) continue;
    const sign = r.bill_type === "RETURN" ? -1 : r.bill_type === "SALE" ? 1 : 0;
    if (sign === 0) continue;
    const { key, styleNo, color } = styleColorKeyOf(r.item_code);
    const cur = salesByKey.get(key) ?? { styleNo, color, qty: 0 };
    cur.qty += sign * Number(r.total_quantity);
    salesByKey.set(key, cur);
    salesByItem.set(r.item_code, (salesByItem.get(r.item_code) ?? 0) + sign * Number(r.total_quantity));
  }

  const totalStock = [...stockByKey.values()].reduce((s, v) => s + Math.max(0, v.qty), 0);
  const totalSales = [...salesByKey.values()].reduce((s, v) => s + Math.max(0, v.qty), 0);

  const allKeys = new Set<string>([...stockByKey.keys(), ...salesByKey.keys()]);
  const rows: MixRow[] = [];
  for (const key of allKeys) {
    const stockEntry = stockByKey.get(key);
    const salesEntry = salesByKey.get(key);
    const styleNo = stockEntry?.styleNo ?? salesEntry?.styleNo ?? key.split("::")[0] ?? key;
    const color = stockEntry?.color ?? salesEntry?.color ?? key.split("::")[1] ?? "—";
    const soh = stockEntry?.qty ?? 0;
    const sales = Math.max(0, salesEntry?.qty ?? 0); // negative net (more returns than sales) never counts as "selling"
    if (soh === 0 && sales === 0) continue;

    const saleMixPct = totalSales > 0 ? (sales / totalSales) * 100 : 0;
    const stockMixPct = totalStock > 0 ? (Math.max(0, soh) / totalStock) * 100 : 0;
    const mixGapPts = saleMixPct - stockMixPct;

    rows.push({
      styleNo,
      color,
      sales,
      saleMixPct,
      soh,
      stockMixPct,
      mixGapPts,
      status: classifyMixGap(mixGapPts),
      warehouseAvailable: warehouseByKey.get(key) ?? 0,
      negativeStock: soh < 0,
    });
  }

  rows.sort((a, b) => b.mixGapPts - a.mixGapPts);

  // Item-level rows for the attribute-wise views — same inclusion rule as
  // above (drop an item with zero stock AND zero sales in scope), but no
  // percentage/status computed here: those depend on which attribute the
  // caller groups by, so lib/replenishment/mixAttributes.ts computes them
  // client-side after the user picks a "View by" pill.
  const allItemCodes = new Set<string>([...stockByItem.keys(), ...salesByItem.keys()]);
  const itemRows: MixItemRow[] = [];
  for (const itemCode of allItemCodes) {
    const attrs = itemAttrs.get(itemCode);
    const soh = stockByItem.get(itemCode) ?? 0;
    const sales = Math.max(0, salesByItem.get(itemCode) ?? 0);
    if (soh === 0 && sales === 0) continue;
    itemRows.push({
      itemCode,
      styleNo: attrs?.styleNo ?? itemCode,
      color: attrs?.color ?? "—",
      size: attrs?.size ?? "—",
      sizeGroup: attrs?.sizeGroup ?? "—",
      gender: attrs?.gender ?? "—",
      season: attrs?.season ?? "—",
      mrp: attrs?.mrp ?? null,
      sales,
      soh,
      warehouseAvailable: warehouseByItem.get(itemCode) ?? 0,
    });
  }

  return { storeList, rows, itemRows, totalSales, totalStock };
}
