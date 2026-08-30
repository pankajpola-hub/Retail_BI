import "server-only";
import { fetchAllRows } from "@/lib/data/client";
import type { DataClient } from "@/lib/data/client";
import { fetchShopifyInventory } from "@/lib/shopify/client";

// Stock Status - side-by-side comparison of WH (warehouse) stock against
// Shopify's live SOH, per style/colour. Ported from the Shopify
// image-uploader project's "Stock Status" feature
// (D:\Py\Shopify image uploader\server\main.py, build_stock_status) - same
// comparison logic, different data sources: WH stock there came from an
// uploaded Excel; here it's already live in Supabase
// (sales.vw_stock_with_scheme), so no upload step is needed on this side.

type StoreRow = { branch_name_erp: string };
type StockRow = {
  branch_name: string | null;
  item_code: string;
  item_name: string | null;
  shade_name: string | null;
  closing_stock: number;
};

function orDash(v: string | null | undefined): string {
  return v && v.trim() ? v : "—";
}
function normalizeColor(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]/g, "");
}

export type StockStatusRow = {
  style: string;
  colour: string;
  title: string;
  whStock: number;
  whHasData: boolean;
  shopifySoh: number;
  shopifyHasData: boolean;
  diff: number;
  match: boolean;
  status: string;
  onShopify: boolean;
};

export async function computeStockStatus(supabase: DataClient): Promise<StockStatusRow[]> {
  const [{ data: storesData }, stockRows, shopify] = await Promise.all([
    supabase.schema("core").from<StoreRow>("stores").select("branch_name_erp"),
    // sales.vw_stock_with_scheme, same source lib/replenishment/mix.ts reads
    // for its own warehouse-vs-store split - see that file's
    // warehouseByKey for the precedent this mirrors.
    fetchAllRows(() =>
      supabase
        .schema("sales")
        .from<StockRow>("vw_stock_with_scheme")
        .select("branch_name, item_code, item_name, shade_name, closing_stock")
        .order("branch_name", { ascending: true })
        .order("item_code", { ascending: true })
    ),
    fetchShopifyInventory(),
  ]);

  const storeBranches = new Set((storesData ?? []).map((s) => s.branch_name_erp));

  // WH stock = closing_stock summed per style+colour, warehouse branches
  // only - any branch_name that ISN'T a known store (same inference
  // lib/replenishment/mix.ts's warehouseByKey uses: `if (!rowStoreId)`).
  const whByKey = new Map<string, number>();
  for (const r of stockRows ?? []) {
    if (!r.branch_name || storeBranches.has(r.branch_name)) continue;
    const style = r.item_name ?? r.item_code;
    const colour = normalizeColor(orDash(r.shade_name));
    const key = `${style}::${colour}`;
    whByKey.set(key, (whByKey.get(key) ?? 0) + Number(r.closing_stock));
  }

  // Union of both sides' keys - a style/colour that exists on only one side
  // still shows up, rather than an inner join silently dropping it.
  const allKeys = new Set<string>([...whByKey.keys(), ...shopify.sohByKey.keys()]);
  const rows: StockStatusRow[] = [];
  for (const key of allKeys) {
    const sep = key.indexOf("::");
    const style = key.slice(0, sep);
    const colour = key.slice(sep + 2);
    const wh = whByKey.get(key);
    const shop = shopify.sohByKey.get(key);
    const onShopify = shopify.titleByStyle.has(style);
    rows.push({
      style,
      colour,
      title: shopify.titleByStyle.get(style) ?? "",
      whStock: wh ?? 0,
      whHasData: wh !== undefined,
      shopifySoh: shop ?? 0,
      shopifyHasData: shop !== undefined,
      diff: (wh ?? 0) - (shop ?? 0),
      match: wh !== undefined && shop !== undefined && wh === shop,
      status: onShopify ? shopify.statusByStyle.get(style) ?? "" : "Not on Shopify",
      onShopify,
    });
  }
  return rows;
}
