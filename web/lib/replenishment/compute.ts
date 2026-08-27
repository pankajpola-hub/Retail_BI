import "server-only";
import { fetchAllRows } from "@/lib/data/client";
import type { DataClient } from "@/lib/data/client";

// `??` only replaces null/undefined, not "" — this app's ERP-sourced text
// columns have, in the past, carried genuine empty strings rather than NULL
// for "not set" (found 2026-08-25 in Sale vs Stock Mix). Every attribute
// field below goes through this instead of a bare `?? "—"` for that reason.
function orDash(v: string | null | undefined): string {
  return v && v.trim() ? v : "—";
}

// Shared by web/app/(replenishment)/replenishment/page.tsx and
// web/app/api/replenishment/download/route.ts — the network allocation
// engine (stock/sales fetch through the priority-ranked warehouse/store
// transfer loop) used to live only in the page, which meant the Excel
// download would have had to reimplement several hundred lines of the same
// logic from scratch, with the two copies inevitably drifting out of sync.
// Both callers now call computeReplenishmentRows() with the same
// query-param-derived assumptions and get back the identical row set —
// the page slices it for pagination, the download route writes all of it.

export type StoreRow = { store_id: string; store_name: string; branch_name_erp: string; is_active: boolean };
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
  gross_amount: number;
  // 0085/0087 — item_master joined directly onto the sale row, independent
  // of whether this item_code has any current stock (see the itemAttrs
  // build-up below — the same fallback mix.ts already relies on, ported
  // here because this file had the identical "barcode instead of style
  // code" bug: itemToStyleColor used to be built from stock rows ONLY, so
  // any item_code that had fully sold through (no current closing_stock
  // row) silently fell back to `{ styleNo: itemCode }` — the barcode
  // itself standing in for the style — even though a real master upload
  // had the attributes all along, just unreachable via the stock-only path.
  item_name: string | null;
  shade_name: string | null;
  gender: string | null;
  size_group: string | null;
  size: string | null;
  season: string | null;
  mrp: number | string | null;
};

export type Priority = "critical" | "high" | "medium" | "healthy" | "exhausted";
export type Trend = "accelerating" | "stable" | "declining";
export type Action =
  | "REPLENISH FROM WAREHOUSE"
  | "TRANSFER FROM STORE"
  | "PURCHASE"
  | "MONITOR"
  | "DO NOT REPLENISH"
  | "NO ACTION"
  | "EXHAUSTED";

export type SizeRow = { size: string; soh: number; sales30d: number; velocity: number };

// Item_code (barcode) grain, PER STORE — same grain as Row itself (Style+
// Color+Store), not network-summed, specifically so a Store filter can
// scope this view exactly the way it scopes the main grid. Feeds the
// "View by" attribute combo (Color / Size / Size Group / Gender /
// Season+Year / MRP Range) client-side, same mechanism as
// lib/replenishment/mixAttributes.ts. No recommendedQty here deliberately:
// that's a Style+Color+Store-grain OUTPUT of the network allocation loop
// below, not a real per-item_code number — splitting it across sizes would
// require inventing a per-size allocation the engine never actually
// computed. This view is diagnostic (stock vs demand), same as Sale vs
// Stock Mix, not a second allocator.
export type ReplItemRow = {
  itemCode: string;
  styleNo: string;
  color: string;
  size: string;
  sizeGroup: string;
  gender: string;
  season: string;
  mrp: number | null;
  storeId: string;
  storeName: string;
  soh: number; // this store's stock
  warehouseAvailable: number; // network warehouse total for this item_code (not store-scoped — a shared pool)
  sales30d: number; // this store's net units, last 30 days
};

export type Row = {
  styleNo: string;
  color: string;
  storeId: string;
  storeName: string;
  soh: number;
  dailyDemand: number;
  sales30d: number;
  salesValue30d: number;
  coverDays: number | null; // null = infinite (stock but no recent sales)
  reorderPoint: number;
  targetStock: number;
  recommendedQty: number;
  warehouseAvailable: number;
  // Style-color-level attributes (constant across every size of this
  // style+color) — sourced from itemAttrs below. Distinct from Size/Size
  // Group, which are item_code (barcode) grain and only exist on itemRows.
  gender: string;
  season: string;
  mrp: number | null;
  trend: Trend | null;
  trendPct: number | null;
  score: number;
  action: Action;
  source: string;
  priority: Priority;
  why: string;
  sizeBreakdown: SizeRow[];
};

export function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-IN");
}
export function fmt1(n: number): string {
  return n.toFixed(1);
}

type Demand = { d7: number; d30: number; d60: number; d90: number };
const EMPTY_DEMAND: Demand = { d7: 0, d30: 0, d60: 0, d90: 0 };

/** Recent sales weighted higher than older sales — weights configurable via query params. */
function weightedDaily(d: Demand, w: { w7: number; w30: number; w60: number; w90: number }): number {
  return Math.max(0, (d.d7 / 7) * w.w7 + (d.d30 / 30) * w.w30 + (d.d60 / 60) * w.w60 + (d.d90 / 90) * w.w90);
}

/** Accelerating / stable / declining — recent velocity (7d) vs the 30d baseline. */
function classifyTrend(d: Demand): { trend: Trend; pct: number | null } {
  const v7 = d.d7 / 7;
  const v30 = d.d30 / 30;
  if (v30 <= 0) return { trend: v7 > 0 ? "accelerating" : "stable", pct: null };
  const pct = ((v7 - v30) / v30) * 100;
  if (pct >= 25) return { trend: "accelerating", pct };
  if (pct <= -25) return { trend: "declining", pct };
  return { trend: "stable", pct };
}

export type ScoreWeights = {
  stockoutRisk: number;
  velocity: number;
  cover: number;
  salesValue: number;
  trend: number;
  productivity: number;
};

export type ReplenishmentAssumptions = {
  targetCoverDays: number;
  leadTimeDays: number;
  safetyDays: number;
  scoreWeights: ScoreWeights;
};

export async function computeReplenishmentRows(
  supabase: DataClient,
  { targetCoverDays, leadTimeDays, safetyDays, scoreWeights: SCORE_W }: ReplenishmentAssumptions
): Promise<{ storeList: StoreRow[]; rows: Row[]; itemRows: ReplItemRow[]; totalWarehouseUnits: number }> {
  const EXCESS_MULTIPLIER = 1.75; // stock this many times target = flagged excess, not just "healthy"
  const DEMAND_WEIGHTS = { w7: 0.4, w30: 0.3, w60: 0.2, w90: 0.1 };
  const SCORE_W_TOTAL =
    SCORE_W.stockoutRisk + SCORE_W.velocity + SCORE_W.cover + SCORE_W.salesValue + SCORE_W.trend + SCORE_W.productivity || 1;

  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  const fromDate = ninetyDaysAgo.toISOString().slice(0, 10);

  // stores/stock/sale are three fully independent queries — stores is only
  // used AFTER all three resolve (to build storeBranchToId for grouping),
  // never as an input filter to the stock/sale queries below. Previously
  // fetched sequentially before the other two; now genuinely parallel.
  // Every branch (store AND warehouse) — warehouse rows are whatever branch
  // isn't a known store, not a hardcoded name, so a renamed or additional
  // warehouse branch doesn't silently disappear from this page.
  const [{ data: storesData }, stockRows, saleRows] = await Promise.all([
    supabase
      .schema("core")
      .from<StoreRow>("stores")
      .select("store_id, store_name, branch_name_erp, is_active")
      .order("store_id"),
    // .order() is required for .range()-based pagination to be a correct
    // partition of the view across separate REST calls, not decoration —
    // see lib/replenishment/mix.ts's identical pair of queries for the full
    // story (confirmed live 2026-08-26 as a 791-row undercount on a sibling
    // project's own paginated fetch). Ordered by every non-numeric
    // dimension column actually selected below.
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
        .select(
          "branch_name, item_code, bill_date, total_quantity, bill_type, gross_amount, item_name, shade_name, gender, size_group, size, season, mrp"
        )
        .gte("bill_date", fromDate)
        .order("branch_name", { ascending: true })
        .order("item_code", { ascending: true })
        .order("bill_date", { ascending: true })
        .order("bill_type", { ascending: true })
    ),
  ]);
  // Inactive stores (core.stores.is_active = false, e.g. discontinued or
  // not-yet-operational branches — see 0091_bo002_bo004_stores.sql) are
  // excluded from every per-store view the same way, this app-wide.
  const storeList = (storesData ?? []).filter((s) => s.is_active);
  const storeBranchToId = new Map(storeList.map((s) => [s.branch_name_erp, s.store_id]));

  // --- Grain: Style No. + Color, not barcode (item_code = one row per
  // size). item_name in this data IS the style code, shade_name is the
  // color — a barcode-level table would split one merchandising decision
  // into 5-8 near-duplicate rows, one per size.
  //
  // itemAttrs maps every barcode (item_code) seen anywhere to its full set
  // of master attributes, built from TWO sources — stock first, then sale
  // as a fallback — same dual-source pattern lib/replenishment/mix.ts uses
  // and for the identical reason: an item_code that has fully sold through
  // (closing_stock 0/absent) never appears in vw_stock_with_scheme at all,
  // so relying on stock rows alone silently fell back to the barcode
  // itself as the "style code" for any such item — a real bug, not a
  // missing-master-data problem (the master upload's attributes ARE there,
  // just unreachable via the stock-only path). vw_sale_transactions_export
  // joins item_master directly onto the sale row regardless of current
  // stock, so it's a real second source, not a guess. ---
  const itemAttrs = new Map<
    string,
    { styleNo: string; color: string; size: string; sizeGroup: string; gender: string; season: string; mrp: number | null }
  >();
  function mrpOf(v: number | string | null): number | null {
    const n = v === null || v === undefined ? null : Number(v);
    return n !== null && Number.isFinite(n) && n > 0 ? n : null;
  }
  for (const r of stockRows ?? []) {
    if (!itemAttrs.has(r.item_code)) {
      itemAttrs.set(r.item_code, {
        styleNo: r.item_name ?? r.item_code,
        color: orDash(r.shade_name),
        size: orDash(r.size),
        sizeGroup: orDash(r.size_group),
        gender: orDash(r.gender),
        season: orDash(r.season),
        mrp: mrpOf(r.mrp),
      });
    }
  }
  for (const r of saleRows ?? []) {
    if (!itemAttrs.has(r.item_code)) {
      itemAttrs.set(r.item_code, {
        styleNo: r.item_name ?? r.item_code,
        color: orDash(r.shade_name),
        size: orDash(r.size),
        sizeGroup: orDash(r.size_group),
        gender: orDash(r.gender),
        season: orDash(r.season),
        mrp: mrpOf(r.mrp),
      });
    }
  }
  // Style+Color-level attributes (constant across every size of that
  // style+color) — one lookup per key, taken from the first item_code seen
  // for it, for carrying gender/season/mrp onto Row without re-deriving
  // them per candidate below.
  const keyAttrs = new Map<string, { gender: string; season: string; mrp: number | null }>();
  function styleColorKeyOf(itemCode: string): { key: string; styleNo: string; color: string } {
    const meta = itemAttrs.get(itemCode) ?? { styleNo: itemCode, color: "—", gender: "—", season: "—", mrp: null };
    const key = `${meta.styleNo}::${meta.color}`;
    if (!keyAttrs.has(key)) keyAttrs.set(key, { gender: meta.gender, season: meta.season, mrp: meta.mrp });
    return { key, styleNo: meta.styleNo, color: meta.color };
  }

  // --- Aggregate stock: store-styleColor and warehouse-styleColor totals,
  // plus item_code (barcode)-level, network-wide totals (itemStock/
  // itemWarehouse) for the "View by" attribute combo — see ReplItemRow. ---
  const storeStock = new Map<string, Map<string, { qty: number; styleNo: string; color: string }>>(); // storeId -> styleColorKey -> {...}
  const warehouseStock = new Map<string, number>(); // styleColorKey -> qty
  const sizeStock = new Map<string, Map<string, Map<string, number>>>(); // storeId -> styleColorKey -> size -> qty
  const itemStock = new Map<string, Map<string, number>>(); // storeId -> item_code -> qty
  const itemWarehouse = new Map<string, number>(); // item_code -> warehouse qty, network-wide (shared pool, not store-scoped)
  for (const r of stockRows ?? []) {
    if (!r.branch_name) continue;
    const { key, styleNo, color } = styleColorKeyOf(r.item_code);
    const size = itemAttrs.get(r.item_code)?.size ?? "—";
    const storeId = storeBranchToId.get(r.branch_name);
    if (storeId) {
      const byStyle = storeStock.get(storeId) ?? new Map();
      const cur = byStyle.get(key) ?? { qty: 0, styleNo, color };
      cur.qty += Number(r.closing_stock);
      byStyle.set(key, cur);
      storeStock.set(storeId, byStyle);

      const byStyleSize = sizeStock.get(storeId) ?? new Map();
      const bySize = byStyleSize.get(key) ?? new Map();
      bySize.set(size, (bySize.get(size) ?? 0) + Number(r.closing_stock));
      byStyleSize.set(key, bySize);
      sizeStock.set(storeId, byStyleSize);

      const byStoreItem = itemStock.get(storeId) ?? new Map<string, number>();
      byStoreItem.set(r.item_code, (byStoreItem.get(r.item_code) ?? 0) + Number(r.closing_stock));
      itemStock.set(storeId, byStoreItem);
    } else {
      warehouseStock.set(key, (warehouseStock.get(key) ?? 0) + Number(r.closing_stock));
      itemWarehouse.set(r.item_code, (itemWarehouse.get(r.item_code) ?? 0) + Number(r.closing_stock));
    }
  }

  // --- Aggregate net sales (SALE minus RETURN) + gross value per store-styleColor, by recency window ---
  const demand = new Map<string, Map<string, Demand>>(); // storeId -> styleColorKey -> demand
  const salesValue90d = new Map<string, Map<string, number>>(); // storeId -> styleColorKey -> gross value, 90d
  const storeTotalValue90d = new Map<string, number>(); // storeId -> total gross value, 90d, all styles (productivity proxy)
  const sizeSales30d = new Map<string, Map<string, Map<string, number>>>(); // storeId -> styleColorKey -> size -> net units, 30d
  const itemSales30d = new Map<string, Map<string, number>>(); // storeId -> item_code -> net units, 30d
  const today = new Date();
  const daysAgo = (dateStr: string) => (today.getTime() - new Date(dateStr).getTime()) / 86_400_000;
  for (const r of saleRows ?? []) {
    if (!r.branch_name) continue;
    const storeId = storeBranchToId.get(r.branch_name);
    if (!storeId) continue; // sale rows from warehouse/office channels don't count as store demand
    // OTHER bill types (neither SALE nor RETURN) aren't real store demand.
    if (r.bill_type !== "SALE" && r.bill_type !== "RETURN") continue;
    const { key } = styleColorKeyOf(r.item_code);
    const age = daysAgo(r.bill_date);
    const byStyle = demand.get(storeId) ?? new Map();
    const cur = byStyle.get(key) ?? { ...EMPTY_DEMAND };
    // No sign multiplication here (removed 2026-08-27). total_quantity /
    // gross_amount are stored ALREADY SIGNED — a RETURN row is negative in
    // raw_logic.sales_transactions, matching both the ERP's own Sale Register
    // export and what the whole sales.vw_ebo_* chain assumes when it sums
    // net_amount as stored. Applying `sign` here negated an already-negative
    // return, turning it into POSITIVE demand: returns were inflating
    // replenishment instead of reducing it, by 2x the returned quantity
    // (~1,968 units across the Excel-era rows). See the header comment on
    // toSigned() in app/api/cron/sale-detail-sync/route.ts for the full
    // convention decision.
    const qty = Number(r.total_quantity);
    if (age <= 90) cur.d90 += qty;
    if (age <= 60) cur.d60 += qty;
    if (age <= 30) cur.d30 += qty;
    if (age <= 7) cur.d7 += qty;
    byStyle.set(key, cur);
    demand.set(storeId, byStyle);

    if (age <= 30) {
      const size = itemAttrs.get(r.item_code)?.size ?? "—";
      const byStyleSize = sizeSales30d.get(storeId) ?? new Map();
      const bySize = byStyleSize.get(key) ?? new Map();
      bySize.set(size, (bySize.get(size) ?? 0) + qty);
      byStyleSize.set(key, bySize);
      sizeSales30d.set(storeId, byStyleSize);

      const byStoreItemSales = itemSales30d.get(storeId) ?? new Map<string, number>();
      byStoreItemSales.set(r.item_code, (byStoreItemSales.get(r.item_code) ?? 0) + qty);
      itemSales30d.set(storeId, byStoreItemSales);
    }

    if (age <= 90) {
      const value = Number(r.gross_amount); // already signed — see the qty note above
      const valByStyle = salesValue90d.get(storeId) ?? new Map();
      valByStyle.set(key, (valByStyle.get(key) ?? 0) + value);
      salesValue90d.set(storeId, valByStyle);
      storeTotalValue90d.set(storeId, (storeTotalValue90d.get(storeId) ?? 0) + value);
    }
  }
  const maxStoreValue = Math.max(1, ...storeList.map((s) => storeTotalValue90d.get(s.store_id) ?? 0));

  // --- Priority score (0-100): stock-out risk + demand velocity + days of
  // cover + revenue potential + sales trend + store productivity, weighted
  // per SCORE_W (user-adjustable on the page). Saturating heuristic scales
  // (documented, not measured constants) — reasonable starting points, easy
  // to retune once real usage shows what "high" actually looks like. ---
  function scoreOf(params: {
    dailyDemand: number;
    coverDays: number | null;
    trend: Trend;
    dailyValue: number;
    storeId: string;
  }): number {
    const velocityScore = Math.min(100, params.dailyDemand * 40);
    const stockoutRiskScore =
      params.coverDays === null ? 0 : Math.max(0, Math.min(100, 100 - (params.coverDays / leadTimeDays) * 50));
    const trendScore = params.trend === "accelerating" ? 100 : params.trend === "stable" ? 50 : 0;
    const salesValueScore = Math.min(100, (params.dailyValue / 500) * 100);
    const coverScore =
      params.coverDays === null ? 0 : Math.max(0, Math.min(100, 100 - (params.coverDays / targetCoverDays) * 100));
    const productivityScore = ((storeTotalValue90d.get(params.storeId) ?? 0) / maxStoreValue) * 100;
    return (
      (velocityScore * SCORE_W.velocity +
        stockoutRiskScore * SCORE_W.stockoutRisk +
        trendScore * SCORE_W.trend +
        salesValueScore * SCORE_W.salesValue +
        coverScore * SCORE_W.cover +
        productivityScore * SCORE_W.productivity) /
      SCORE_W_TOTAL
    );
  }

  // --- Every style-color key present anywhere (stock or sales, store or warehouse) ---
  const allKeys = new Set<string>([...warehouseStock.keys()]);
  for (const store of storeList) {
    for (const k of (storeStock.get(store.store_id) ?? new Map()).keys()) allKeys.add(k);
    for (const k of (demand.get(store.store_id) ?? new Map()).keys()) allKeys.add(k);
  }

  const rows: Row[] = [];

  // Per-size SOH + 30d sales for one store x style-color. Called only for
  // Critical rows since it's the one place a style-color-level number can
  // hide a real per-size shortage — a "6 units in stock" that's actually "0
  // in the two sizes people are buying."
  function sizeBreakdownFor(storeId: string, key: string): SizeRow[] {
    const sohBySize = sizeStock.get(storeId)?.get(key) ?? new Map<string, number>();
    const salesBySize = sizeSales30d.get(storeId)?.get(key) ?? new Map<string, number>();
    const sizes = new Set([...sohBySize.keys(), ...salesBySize.keys()]);
    return [...sizes]
      .map((size) => {
        const soh = sohBySize.get(size) ?? 0;
        const sales30d = Math.max(0, salesBySize.get(size) ?? 0);
        return { size, soh, sales30d, velocity: sales30d / 30 };
      })
      .sort((a, b) => b.velocity - a.velocity || b.sales30d - a.sales30d);
  }

  // --- Network allocation: process one style-color at a time across ALL
  // stores together, not independently — a shared warehouse pool and a
  // shared "excess to transfer" pool both get consumed in priority order, so
  // two stores needing the same style-color don't each claim the full
  // warehouse quantity. ---
  for (const key of allKeys) {
    const whTotal = warehouseStock.get(key) ?? 0;
    let whRemaining = whTotal;

    type Candidate = {
      store: StoreRow;
      soh: number;
      dailyDemand: number;
      sales30d: number;
      coverDays: number | null;
      targetStock: number;
      reorderPoint: number;
      need: number;
      trend: Trend;
      trendPct: number | null;
      score: number;
      styleNo: string;
      color: string;
    };

    const candidates: Candidate[] = [];
    let networkStoreStock = 0;
    let anyDemand = false;

    for (const store of storeList) {
      const stockEntry = storeStock.get(store.store_id)?.get(key);
      const soh = stockEntry?.qty ?? 0;
      networkStoreStock += soh;
      const d = demand.get(store.store_id)?.get(key) ?? EMPTY_DEMAND;
      const dailyDemand = weightedDaily(d, DEMAND_WEIGHTS);
      if (soh === 0 && dailyDemand === 0) continue;
      if (dailyDemand > 0) anyDemand = true;

      const styleNo = stockEntry?.styleNo ?? key.split("::")[0] ?? key;
      const color = stockEntry?.color ?? key.split("::")[1] ?? "—";
      const coverDays = dailyDemand > 0 ? soh / dailyDemand : soh > 0 ? null : 0;
      const safetyStock = dailyDemand * safetyDays;
      const reorderPoint = dailyDemand * leadTimeDays + safetyStock;
      const targetStock = dailyDemand * targetCoverDays + safetyStock;
      const need = Math.max(0, Math.round(targetStock - soh));
      const { trend, pct } = classifyTrend(d);
      const dailyValue = ((salesValue90d.get(store.store_id)?.get(key) ?? 0) / 90) || 0;
      const score = scoreOf({ dailyDemand, coverDays, trend, dailyValue, storeId: store.store_id });

      candidates.push({
        store,
        soh,
        dailyDemand,
        sales30d: d.d30,
        coverDays,
        targetStock,
        reorderPoint,
        need,
        trend,
        trendPct: pct,
        score,
        styleNo,
        color,
      });
    }

    if (candidates.length === 0) continue;
    const styleNo = candidates[0]!.styleNo;
    const color = candidates[0]!.color;
    const attrsForKey = keyAttrs.get(key) ?? { gender: "—", season: "—", mrp: null };

    // Network stock (warehouse + all stores) is zero but demand exists
    // somewhere -> EXHAUSTED, no replenish/transfer/purchase action.
    if (whTotal === 0 && networkStoreStock === 0 && anyDemand) {
      for (const c of candidates) {
        if (c.dailyDemand <= 0) continue;
        rows.push({
          styleNo,
          color,
          storeId: c.store.store_id,
          storeName: c.store.store_name,
          soh: 0,
          dailyDemand: c.dailyDemand,
          sales30d: c.sales30d,
          salesValue30d: 0,
          coverDays: 0,
          reorderPoint: c.reorderPoint,
          targetStock: c.targetStock,
          recommendedQty: 0,
          warehouseAvailable: 0,
          gender: attrsForKey.gender,
          season: attrsForKey.season,
          mrp: attrsForKey.mrp,
          trend: c.trend,
          trendPct: c.trendPct,
          score: c.score,
          action: "EXHAUSTED",
          source: "—",
          priority: "exhausted",
          why: `No network stock left anywhere (warehouse or stores) while this store is still selling it (${fmt1(c.dailyDemand)}/day). No replenishment, transfer, or purchase is being recommended — this style-color is out of the game until new stock is sourced.`,
          sizeBreakdown: [],
        });
      }
      continue;
    }

    // Excess pool: stores with SOH above their own target, available as a
    // transfer source — shared across all needing stores, decremented as
    // it's used, same as the warehouse pool.
    const excessPool = candidates
      .map((c) => ({ storeId: c.store.store_id, storeName: c.store.store_name, remaining: Math.max(0, c.soh - c.targetStock) }))
      .filter((e) => e.remaining > 0);

    // Needing stores, highest priority score first.
    const needers = candidates.filter((c) => c.need > 0).sort((a, b) => b.score - a.score);
    const handledStoreIds = new Set<string>();

    for (const c of needers) {
      handledStoreIds.add(c.store.store_id);
      let remainingNeed = c.need;
      const fromWarehouse = Math.min(remainingNeed, whRemaining);
      whRemaining -= fromWarehouse;
      remainingNeed -= fromWarehouse;

      const transfers: { from: string; qty: number }[] = [];
      for (const src of excessPool) {
        if (remainingNeed <= 0) break;
        if (src.storeId === c.store.store_id || src.remaining <= 0) continue;
        const take = Math.min(remainingNeed, src.remaining);
        if (take <= 0) continue;
        src.remaining -= take;
        remainingNeed -= take;
        transfers.push({ from: src.storeName, qty: take });
      }

      const allocated = c.need - remainingNeed;
      const cover = c.coverDays === null ? "no recent sales" : `${fmt1(c.coverDays)}d cover`;
      let action: Action;
      let source: string;
      let why: string;

      const parts: string[] = [];
      if (fromWarehouse > 0) parts.push(`Warehouse ${fmt(fromWarehouse)}`);
      for (const t of transfers) parts.push(`${t.from} ${fmt(t.qty)}`);

      if (remainingNeed <= 0 && fromWarehouse > 0 && transfers.length === 0) {
        action = "REPLENISH FROM WAREHOUSE";
        source = "Warehouse";
        why = `Target stock ${fmt(c.targetStock)} (${targetCoverDays}d cover) vs SOH ${fmt(c.soh)} — short by ${fmt(c.need)}. Warehouse has enough (allocated ${fmt(fromWarehouse)} after priority ordering against other stores needing the same style-color).`;
      } else if (remainingNeed <= 0 && transfers.length > 0) {
        action = "TRANSFER FROM STORE";
        source = parts.join(" + ") || "—";
        why = `Short by ${fmt(c.need)}. Covered by ${parts.join(" + ")} — allocated in priority order (score ${fmt1(c.score)}/100) against other stores competing for the same network stock.`;
      } else if (allocated > 0) {
        action = "TRANSFER FROM STORE";
        source = `${parts.join(" + ") || "—"} (partial, ${fmt(remainingNeed)} unmet)`;
        why = `Short by ${fmt(c.need)}. Network could only supply ${fmt(allocated)} (${parts.join(" + ") || "nothing"}) after higher-priority stores were served first — remaining ${fmt(remainingNeed)} needs a fresh purchase.`;
      } else {
        action = "PURCHASE";
        source = "Vendor — needs manual review (no lead-time/vendor data on file)";
        why = `Short by ${fmt(c.need)}. No warehouse or store excess left for this style-color after higher-priority stores were served (or none existed) — new purchase likely needed, confirm manually.`;
      }

      const priority: Priority =
        c.soh === 0 || (c.coverDays !== null && c.coverDays <= leadTimeDays)
          ? "critical"
          : c.coverDays !== null && c.coverDays <= targetCoverDays * 0.5
            ? "high"
            : "medium";

      rows.push({
        styleNo,
        color,
        storeId: c.store.store_id,
        storeName: c.store.store_name,
        soh: c.soh,
        dailyDemand: c.dailyDemand,
        sales30d: c.sales30d,
        salesValue30d: salesValue90d.get(c.store.store_id)?.get(key) ?? 0,
        coverDays: c.coverDays,
        reorderPoint: c.reorderPoint,
        targetStock: c.targetStock,
        recommendedQty: allocated,
        warehouseAvailable: whTotal,
        gender: attrsForKey.gender,
        season: attrsForKey.season,
        mrp: attrsForKey.mrp,
        trend: c.trend,
        trendPct: c.trendPct,
        score: c.score,
        action,
        source,
        priority,
        why: `${why} (${cover})`,
        sizeBreakdown: priority === "critical" ? sizeBreakdownFor(c.store.store_id, key) : [],
      });
    }

    // Remaining candidates (no need) — healthy, excess (do not replenish), or monitor.
    for (const c of candidates) {
      if (handledStoreIds.has(c.store.store_id)) continue;
      const isExcess = c.dailyDemand > 0 && c.soh > c.targetStock * EXCESS_MULTIPLIER;
      const action2: Action = isExcess ? "DO NOT REPLENISH" : c.dailyDemand > 0 ? "NO ACTION" : "MONITOR";
      rows.push({
        styleNo,
        color,
        storeId: c.store.store_id,
        storeName: c.store.store_name,
        soh: c.soh,
        dailyDemand: c.dailyDemand,
        sales30d: c.sales30d,
        salesValue30d: salesValue90d.get(c.store.store_id)?.get(key) ?? 0,
        coverDays: c.coverDays,
        reorderPoint: c.reorderPoint,
        targetStock: c.targetStock,
        recommendedQty: 0,
        warehouseAvailable: whTotal,
        gender: attrsForKey.gender,
        season: attrsForKey.season,
        mrp: attrsForKey.mrp,
        trend: c.trend,
        trendPct: c.trendPct,
        score: c.score,
        action: action2,
        source: "—",
        priority: "healthy",
        why: isExcess
          ? `SOH ${fmt(c.soh)} is well above target ${fmt(c.targetStock)} (${targetCoverDays}d cover) for current demand — consider markdown/transfer instead of more stock.`
          : c.dailyDemand > 0
            ? `SOH ${fmt(c.soh)} already covers target ${fmt(c.targetStock)} (${targetCoverDays}d cover). No action needed.`
            : `No recent sales in this store; stock sitting at ${fmt(c.soh)}.`,
        sizeBreakdown: [],
      });
    }
  }

  const totalWarehouseUnits = [...warehouseStock.values()].reduce((s, v) => s + v, 0);

  // Item-level rows for the "View by" attribute combo — PER STORE, same
  // grain and same inclusion rule as the main Row loop above (a store only
  // gets a row for an item_code it has stock or sales for; warehouse-only
  // stock with no store presence anywhere isn't attached to any store, same
  // as Row itself never emits a warehouse-only candidate). No
  // recommendedQty (see ReplItemRow's own comment for why).
  const itemRows: ReplItemRow[] = [];
  for (const store of storeList) {
    const storeItemStock = itemStock.get(store.store_id);
    const storeItemSales = itemSales30d.get(store.store_id);
    const itemCodesForStore = new Set<string>([...(storeItemStock?.keys() ?? []), ...(storeItemSales?.keys() ?? [])]);
    for (const itemCode of itemCodesForStore) {
      const attrs = itemAttrs.get(itemCode);
      const soh = storeItemStock?.get(itemCode) ?? 0;
      const warehouseAvailable = itemWarehouse.get(itemCode) ?? 0;
      const sales30d = Math.max(0, storeItemSales?.get(itemCode) ?? 0);
      if (soh === 0 && sales30d === 0) continue;
      itemRows.push({
        itemCode,
        styleNo: attrs?.styleNo ?? itemCode,
        color: attrs?.color ?? "—",
        size: attrs?.size ?? "—",
        sizeGroup: attrs?.sizeGroup ?? "—",
        gender: attrs?.gender ?? "—",
        season: attrs?.season ?? "—",
        mrp: attrs?.mrp ?? null,
        storeId: store.store_id,
        storeName: store.store_name,
        soh,
        warehouseAvailable,
        sales30d,
      });
    }
  }

  return { storeList, rows, itemRows, totalWarehouseUnits };
}

/** Same searchParams-parsing rules the page uses for the what-if assumption inputs — shared so the download route parses identically. */
export function parseAssumptions(searchParams: URLSearchParams): ReplenishmentAssumptions {
  const targetCoverDays = Number(searchParams.get("targetCover")) > 0 ? Number(searchParams.get("targetCover")) : 21;
  const leadTimeDays = Number(searchParams.get("leadTime")) > 0 ? Number(searchParams.get("leadTime")) : 5;
  const safetyDays = Number(searchParams.get("safetyDays")) >= 0 ? Number(searchParams.get("safetyDays")) : 3;
  const nonNegNum = (v: string | null, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    targetCoverDays,
    leadTimeDays,
    safetyDays,
    scoreWeights: {
      stockoutRisk: nonNegNum(searchParams.get("wStockout"), 25),
      velocity: nonNegNum(searchParams.get("wVelocity"), 25),
      cover: nonNegNum(searchParams.get("wCover"), 15),
      salesValue: nonNegNum(searchParams.get("wRevenue"), 15),
      trend: nonNegNum(searchParams.get("wTrend"), 10),
      productivity: nonNegNum(searchParams.get("wProductivity"), 10),
    },
  };
}

export function filterRows(
  rows: Row[],
  { q, store, priority, action }: { q: string; store: string; priority: string; action: string }
): Row[] {
  const qLower = q.trim().toLowerCase();
  return rows.filter((r) => {
    if (qLower && !r.styleNo.toLowerCase().includes(qLower) && !r.color.toLowerCase().includes(qLower)) return false;
    if (store && r.storeId !== store) return false;
    if (priority && r.priority !== priority) return false;
    if (action && r.action !== action) return false;
    return true;
  });
}

export const PRIORITY_ORDER: Priority[] = ["critical", "high", "medium", "healthy", "exhausted"];

export type ReplenishmentKpis = {
  needsReplenishment: number;
  unitsRequired: number;
  criticalCount: number;
  storesAtRisk: number;
  transferCount: number;
  purchaseCount: number;
  exhaustedCount: number;
};

/**
 * The page's own KPI card row, extracted verbatim (2026-08-20) so the
 * Workspace's replenishment_kpi_grid calls the same function
 * app/(replenishment)/replenishment/page.tsx does. Computed over the FULL
 * row set, before the page's own store/priority/action filters apply.
 */
export function computeReplenishmentKpis(rows: Row[]): ReplenishmentKpis {
  const needsReplenishmentRows = rows.filter((r) => r.recommendedQty > 0);
  return {
    needsReplenishment: needsReplenishmentRows.length,
    unitsRequired: needsReplenishmentRows.reduce((s, r) => s + r.recommendedQty, 0),
    criticalCount: rows.filter((r) => r.priority === "critical").length,
    storesAtRisk: new Set(rows.filter((r) => r.priority === "critical").map((r) => r.storeId)).size,
    transferCount: rows.filter((r) => r.action === "TRANSFER FROM STORE").length,
    purchaseCount: rows.filter((r) => r.action === "PURCHASE").length,
    exhaustedCount: rows.filter((r) => r.priority === "exhausted").length,
  };
}

/**
 * "Where should we send stock?" — top N actionable moves by score, plus a
 * rough revenue-protection estimate. Extracted verbatim (2026-08-20) from
 * the same page, same reason as computeReplenishmentKpis above.
 */
export function computeTopSupplyMoves(rows: Row[], topN = 10): { top: Row[]; salesProtected: number } {
  const actionable = rows
    .filter((r) => r.action === "REPLENISH FROM WAREHOUSE" || r.action === "TRANSFER FROM STORE")
    .sort((a, b) => b.score - a.score);
  const top = actionable.slice(0, topN);
  let salesProtected = 0;
  for (const r of top) {
    if (r.sales30d > 0 && r.salesValue30d !== 0) {
      const asp = Math.abs(r.salesValue30d) / (r.sales30d || 1);
      salesProtected += r.recommendedQty * asp;
    }
  }
  return { top, salesProtected };
}
