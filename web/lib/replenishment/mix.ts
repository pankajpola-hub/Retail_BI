import "server-only";
import { fetchAllRows } from "@/lib/data/client";
import type { DataClient } from "@/lib/data/client";
import { classifyMixGap, MIX_STATUS_META, type MixStatus } from "./mixShared";
import { resolveCallerStoreScope } from "@/lib/scope/callerStoreScope";

// Sale Mix vs Stock Mix — Style No. + Color level. Answers: "is the way
// stock is currently distributed aligned with how customers are actually
// buying this style+color?" Independent from the Replenishment allocation
// engine (lib/replenishment/compute.ts) — this is a diagnostic lens, not
// another allocator; the Replenishment page already does the actual
// warehouse/store transfer math using its own (richer) velocity model. Mix
// Gap here is meant to be read alongside Replenishment, not instead of it.

export { classifyMixGap, MIX_STATUS_META, type MixStatus };

type StoreRow = { store_id: string; store_name: string; branch_name_erp: string; is_active: boolean };
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
  // callerStoreScope joins as a fourth independent query — it is not an
  // input filter to the stock/sale reads (those stay network-wide by
  // design, see ./scope.ts), only to which stores may contribute to the
  // rollup below.
  const [{ data: storesData }, stockRows, saleRows, callerStoreScope] = await Promise.all([
    supabase
      .schema("core")
      .from<StoreRow>("stores")
      .select("store_id, store_name, branch_name_erp, is_active")
      .order("store_id"),
    // .order() is required for .range()-based pagination to be a correct
    // partition of the view across separate REST calls, not decoration —
    // confirmed live 2026-08-26 on a sibling project's own paginated fetch
    // (web/app/api/sales-source/sale-detail/route.ts): without an explicit,
    // near-total ORDER BY, Postgres can return rows in a different order
    // between the page-1 and page-2 requests even against unchanged data,
    // silently dropping some rows from every page (or duplicating others)
    // with no error surfaced — a confirmed 791-row undercount there, from
    // this exact gap. Ordered by every non-numeric dimension column
    // actually selected below (not closing_stock/total_quantity/bill_type,
    // which aren't identifying) — reduces, though for a view with no known
    // guaranteed-unique key can't perfectly eliminate, tie-shuffling across
    // page boundaries.
    fetchAllRows(() =>
      supabase
        .schema("sales")
        .from<StockRow>("vw_stock_with_scheme")
        .select("branch_name, item_code, item_name, shade_name, size, size_group, gender, season, mrp, closing_stock")
        .order("branch_name", { ascending: true })
        .order("item_code", { ascending: true })
    ),
    fetchAllRows(() =>
      supabase
        .schema("sales")
        .from<SaleRow>("vw_sale_transactions_export")
        .select("branch_name, item_code, bill_date, total_quantity, bill_type, item_name, shade_name, season, gender, size_group, size, mrp")
        .gte("bill_date", fromDate)
        .order("branch_name", { ascending: true })
        .order("item_code", { ascending: true })
        .order("bill_date", { ascending: true })
        .order("bill_type", { ascending: true })
    ),
    resolveCallerStoreScope(supabase),
  ]);
  // Inactive stores (core.stores.is_active = false, e.g. discontinued or
  // not-yet-operational branches — see 0091_bo002_bo004_stores.sql) are
  // excluded from every per-store view the same way, this app-wide.
  const storeList = (storesData ?? []).filter((s) => s.is_active);
  const storeBranchToId = new Map(storeList.map((s) => [s.branch_name_erp, s.store_id]));

  // --- Store-scope boundary, applied to the two aggregation loops below
  // rather than to a returned row array (unlike compute.ts, whose rows carry
  // a storeId; MixRow/MixItemRow are already a store-agnostic ROLLUP, so by
  // the time rows exist the store attribution is gone and there is nothing
  // left to filter). Narrowing which stores may contribute to the rollup is
  // the same boundary, imposed one step earlier.
  //
  // `storeId` is the user-supplied ?mix_store= param. It is now intersected
  // with the caller's grants instead of trusted: an ungranted store id
  // yields an empty scope (no contributing stores, so zero rows) rather than
  // that store's real mix. Empty `storeId` means "All stores", which now
  // means all of the CALLER'S stores — for a single-store user that is
  // numerically identical to picking their own store, which is the point.
  //
  // Warehouse stock (the `!rowStoreId` branch below) stays network-wide: it
  // is one shared pool, attributed to no store, and feeds the section-8
  // availability check rather than the mix percentages.
  const callerStores = storeList.map((s) => s.store_id).filter((id) => callerStoreScope.has(id));
  const scopeStoreIds = new Set(storeId ? callerStores.filter((id) => id === storeId) : callerStores);

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
    if (!scopeStoreIds.has(rowStoreId)) continue;
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
    if (!scopeStoreIds.has(rowStoreId)) continue;
    // OTHER bill types (neither SALE nor RETURN) aren't store demand.
    if (r.bill_type !== "SALE" && r.bill_type !== "RETURN") continue;
    const { key, styleNo, color } = styleColorKeyOf(r.item_code);
    const cur = salesByKey.get(key) ?? { styleNo, color, qty: 0 };
    // No sign multiplication (removed 2026-08-27) — total_quantity is stored
    // ALREADY SIGNED, a RETURN row being negative. Multiplying by -1 here
    // negated an already-negative return into positive demand, inflating the
    // sale mix by 2x the returned quantity. Same fix as compute.ts:342; see
    // toSigned()'s header in app/api/cron/sale-detail-sync/route.ts for why
    // signed-at-rest is the canonical convention.
    const qty = Number(r.total_quantity);
    cur.qty += qty;
    salesByKey.set(key, cur);
    salesByItem.set(r.item_code, (salesByItem.get(r.item_code) ?? 0) + qty);
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

  // storeList is what the tab's Store <select> renders. Narrowed to the
  // caller's own grants so the control cannot offer a store whose data the
  // scope boundary above would then refuse to show — same reason
  // compute.ts filters its own storeList. totalSales/totalStock need no
  // filtering: they are sums of the already-scoped maps above.
  return {
    storeList: storeList.filter((s) => callerStoreScope.has(s.store_id)),
    rows,
    itemRows,
    totalSales,
    totalStock,
  };
}
