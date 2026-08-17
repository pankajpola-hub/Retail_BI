import "server-only";
import type { DataClient } from "@/lib/data/client";

// Sale Mix vs Stock Mix — Style No. + Color level. Answers: "is the way
// stock is currently distributed aligned with how customers are actually
// buying this style+color?" Independent from the Replenishment allocation
// engine (lib/replenishment/compute.ts) — this is a diagnostic lens, not
// another allocator; the Replenishment page already does the actual
// warehouse/store transfer math using its own (richer) velocity model. Mix
// Gap here is meant to be read alongside Replenishment, not instead of it.

type StoreRow = { store_id: string; store_name: string; branch_name_erp: string };
type StockRow = {
  branch_name: string | null;
  item_code: string;
  item_name: string | null;
  shade_name: string | null;
  closing_stock: number;
};
type SaleRow = {
  branch_name: string | null;
  item_code: string;
  bill_date: string;
  total_quantity: number;
  bill_type: string;
};

export type MixStatus = "high_priority" | "opportunity" | "balanced" | "stock_heavy" | "overstocked";

export const MIX_STATUS_META: Record<
  MixStatus,
  { dot: string; label: string; demandLabel: string; action: string; className: string }
> = {
  high_priority: {
    dot: "🔥",
    label: "High Priority",
    demandLabel: "High Demand / Low Stock",
    action: "Prioritize Allocation",
    className: "text-crit font-semibold",
  },
  opportunity: {
    dot: "🟢",
    label: "Allocation Opportunity",
    demandLabel: "Demand Higher Than Stock",
    action: "Consider Allocation",
    className: "text-good font-semibold",
  },
  balanced: {
    dot: "✅",
    label: "Balanced",
    demandLabel: "Balanced",
    action: "Maintain",
    className: "text-ink-2",
  },
  stock_heavy: {
    dot: "🟠",
    label: "Stock Heavy",
    demandLabel: "Stock Higher Than Demand",
    action: "Reduce / Hold Allocation",
    className: "text-warn font-semibold",
  },
  overstocked: {
    dot: "🔴",
    label: "Overstocked",
    demandLabel: "Low Demand / High Stock",
    action: "Do Not Allocate",
    className: "text-crit font-semibold",
  },
};

// Boundaries taken literally from the spec, with the two ties (+5pp,
// -10pp... and -5pp) each resolved toward the MORE extreme bucket, mirroring
// how the spec's own ">=5 and <10" phrasing puts +5 in Opportunity rather
// than Balanced — the symmetric choice puts -5 in Stock Heavy rather than
// Balanced, so a style-color never lands in two buckets depending on
// floating-point rounding.
export function classifyMixGap(gapPts: number): MixStatus {
  if (gapPts >= 10) return "high_priority";
  if (gapPts >= 5) return "opportunity";
  if (gapPts > -5) return "balanced";
  if (gapPts >= -10) return "stock_heavy";
  return "overstocked";
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

export type SalesPeriodDays = 7 | 30 | 60 | 90;

export async function computeSaleStockMix(
  supabase: DataClient,
  { storeId, salesPeriodDays }: { storeId: string; salesPeriodDays: SalesPeriodDays }
): Promise<{ storeList: StoreRow[]; rows: MixRow[]; totalSales: number; totalStock: number }> {
  const periodStart = new Date();
  periodStart.setDate(periodStart.getDate() - salesPeriodDays);
  const fromDate = periodStart.toISOString().slice(0, 10);

  // stores/stock/sale are independent — stores is only used AFTER all three
  // resolve (grouping), never as an input filter here. Previously fetched
  // sequentially before the other two; now genuinely parallel.
  const [{ data: storesData }, { data: stockRows }, { data: saleRows }] = await Promise.all([
    supabase
      .schema("core")
      .from<StoreRow>("stores")
      .select("store_id, store_name, branch_name_erp")
      .order("store_id"),
    supabase
      .schema("sales")
      .from<StockRow>("vw_stock_with_scheme")
      .select("branch_name, item_code, item_name, shade_name, closing_stock")
      .limit(40000),
    supabase
      .schema("sales")
      .from<SaleRow>("vw_sale_transactions_export")
      .select("branch_name, item_code, bill_date, total_quantity, bill_type")
      .gte("bill_date", fromDate)
      .limit(100000),
  ]);
  const storeList = (storesData ?? []).filter((s) => s.store_id !== "BO-004");
  const storeBranchToId = new Map(storeList.map((s) => [s.branch_name_erp, s.store_id]));

  // Same style+color grain as Replenishment (lib/replenishment/compute.ts) —
  // never combine colors of the same style (section 1 of the spec).
  const itemToStyleColor = new Map<string, { styleNo: string; color: string }>();
  for (const r of stockRows ?? []) {
    if (!itemToStyleColor.has(r.item_code)) {
      itemToStyleColor.set(r.item_code, { styleNo: r.item_name ?? r.item_code, color: r.shade_name ?? "—" });
    }
  }
  function styleColorKeyOf(itemCode: string): { key: string; styleNo: string; color: string } {
    const meta = itemToStyleColor.get(itemCode) ?? { styleNo: itemCode, color: "—" };
    return { key: `${meta.styleNo}::${meta.color}`, styleNo: meta.styleNo, color: meta.color };
  }

  // Stock Mix is built from STORE stock only (not warehouse) — the question
  // this feature answers is "does what's on the shop floor match how
  // customers are buying," so warehouse bulk stock (tracked separately
  // below for the section-8 availability check) would distort it if mixed
  // in. Section 7: when storeId is set, only that store's own SOH/sales
  // count — another store's numbers must never leak into a per-store view.
  const stockByKey = new Map<string, { styleNo: string; color: string; qty: number }>();
  const warehouseByKey = new Map<string, number>();
  for (const r of stockRows ?? []) {
    if (!r.branch_name) continue;
    const { key, styleNo, color } = styleColorKeyOf(r.item_code);
    const rowStoreId = storeBranchToId.get(r.branch_name);
    if (!rowStoreId) {
      warehouseByKey.set(key, (warehouseByKey.get(key) ?? 0) + Number(r.closing_stock));
      continue;
    }
    if (storeId && rowStoreId !== storeId) continue;
    const cur = stockByKey.get(key) ?? { styleNo, color, qty: 0 };
    cur.qty += Number(r.closing_stock);
    stockByKey.set(key, cur);
  }

  // Sales Mix: net units (SALE - RETURN), OTHER (cancelled/unclassified)
  // excluded entirely so cancellations never inflate the denominator either
  // (section 12 — "returns and cancelled orders should not inflate sales
  // quantity").
  const salesByKey = new Map<string, { styleNo: string; color: string; qty: number }>();
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
  return { storeList, rows, totalSales, totalStock };
}
