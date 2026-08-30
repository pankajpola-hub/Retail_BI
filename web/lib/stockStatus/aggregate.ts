import "server-only";
import { fetchAllRows } from "@/lib/data/client";
import type { DataClient } from "@/lib/data/client";
import { fetchShopifyInventory } from "@/lib/shopify/client";
import { CHANNELS, type ChannelSummary } from "@/lib/inventory/model";

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
  godown_name: string | null;
  item_code: string;
  item_name: string | null;
  shade_name: string | null;
  season: string | null;
  gender: string | null;
  size_group: string | null;
  subcategory: string | null;
  market_segment: string | null;
  mrp: number | string | null;
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
  // Item-master attributes (raw_logic.item_master, joined onto
  // vw_stock_with_scheme already) - style-level, so the first
  // warehouse-side row seen for a style+colour sets these. A style/colour
  // that ONLY exists on Shopify (never in the WH stock rows) has no
  // master-data row to read these from, so they come through as "—".
  season: string;
  gender: string;
  sizeGroup: string;
  subcategory: string;
  marketSegment: string;
  mrp: number | null;
  // "Live" = actually purchasable on Shopify right now (on Shopify AND
  // stock > 0). "Can Go Live" = WH has stock ready to sell but it isn't
  // showing on Shopify yet (not listed at all, or listed with 0 SOH) - the
  // actionable "push this live" list. "Not Live" = neither side has stock,
  // nothing to action.
  goLiveStatus: "Live" | "Can Go Live" | "Not Live";
};

export async function computeStockStatus(
  supabase: DataClient,
  { godowns }: { godowns?: string[] } = {}
): Promise<{
  rows: StockStatusRow[];
  availableGodowns: string[];
  channelSummaries: ChannelSummary[];
  totalWhStockValue: number; // closing_stock x item_master.mrp, MRP-based - no distinct cost/selling price field exists in the source data
}> {
  const [{ data: storesData }, stockRows, shopify] = await Promise.all([
    supabase.schema("core").from<StoreRow>("stores").select("branch_name_erp"),
    // sales.vw_stock_with_scheme, same source lib/replenishment/mix.ts reads
    // for its own warehouse-vs-store split - see that file's
    // warehouseByKey for the precedent this mirrors. godown_name + the
    // item_master attribute columns are already exposed on this view
    // (0097_scope_sale_export_stock_scheme.sql), no extra join needed.
    fetchAllRows(() =>
      supabase
        .schema("sales")
        .from<StockRow>("vw_stock_with_scheme")
        .select(
          "branch_name, godown_name, item_code, item_name, shade_name, season, gender, size_group, subcategory, market_segment, mrp, closing_stock"
        )
        .order("branch_name", { ascending: true })
        .order("item_code", { ascending: true })
    ),
    fetchShopifyInventory(),
  ]);

  const storeBranches = new Set((storesData ?? []).map((s) => s.branch_name_erp));
  const godownFilter = godowns && godowns.length > 0 ? new Set(godowns) : null;

  // Every warehouse-side godown seen, regardless of the active filter - so
  // the filter control always offers every option, not just whichever
  // subset happens to be selected right now.
  const availableGodownsSet = new Set<string>();

  // WH stock = closing_stock summed per style+colour, warehouse branches
  // only (any branch_name that ISN'T a known store - same inference
  // lib/replenishment/mix.ts's warehouseByKey uses: `if (!rowStoreId)`),
  // further narrowed to the selected godown(s) when a filter is active -
  // comparing Shopify's ecommerce SOH against the WHOLE warehouse (which
  // can include non-ecom godowns, e.g. an EBO/offline bulk store) isn't
  // the right comparison; the caller is expected to filter down to the
  // ecom godown(s) for that reason.
  const whByKey = new Map<string, number>();
  const attrsByKey = new Map<
    string,
    { season: string; gender: string; sizeGroup: string; subcategory: string; marketSegment: string; mrp: number | null }
  >();
  for (const r of stockRows ?? []) {
    if (!r.branch_name || storeBranches.has(r.branch_name)) continue;
    const godown = orDash(r.godown_name);
    availableGodownsSet.add(godown);

    const style = r.item_name ?? r.item_code;
    const colour = normalizeColor(orDash(r.shade_name));
    const key = `${style}::${colour}`;
    if (!attrsByKey.has(key)) {
      const mrpNum = r.mrp === null || r.mrp === undefined ? null : Number(r.mrp);
      attrsByKey.set(key, {
        season: orDash(r.season),
        gender: orDash(r.gender),
        sizeGroup: orDash(r.size_group),
        subcategory: orDash(r.subcategory),
        marketSegment: orDash(r.market_segment),
        mrp: mrpNum !== null && Number.isFinite(mrpNum) && mrpNum > 0 ? mrpNum : null,
      });
    }

    if (godownFilter && !godownFilter.has(godown)) continue;
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
    const attrs = attrsByKey.get(key);
    const isLive = onShopify && shop !== undefined && shop > 0;
    const canGoLive = !isLive && wh !== undefined && wh > 0;
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
      season: attrs?.season ?? "—",
      gender: attrs?.gender ?? "—",
      sizeGroup: attrs?.sizeGroup ?? "—",
      subcategory: attrs?.subcategory ?? "—",
      marketSegment: attrs?.marketSegment ?? "—",
      mrp: attrs?.mrp ?? null,
      goLiveStatus: isLive ? "Live" : canGoLive ? "Can Go Live" : "Not Live",
    });
  }

  const totalWhStockValue = rows.reduce((s, r) => s + (r.whHasData && r.mrp ? r.whStock * r.mrp : 0), 0);

  // Channel comparison - one row per registered channel (lib/inventory/model.ts),
  // not just the ones with real data. Only `active` channels get real
  // numbers computed from `rows`; the rest carry active:false so the UI can
  // render an honest "Not connected" instead of a fabricated 0.
  const channelSummaries: ChannelSummary[] = CHANNELS.map((ch) => {
    if (!ch.active) {
      return {
        channelId: ch.id,
        channelName: ch.name,
        active: false,
        liveSkus: 0,
        sellableUnits: 0,
        whEligibleUnits: 0,
        missingUnits: 0,
        mismatchUnits: 0,
        availabilityPct: null,
      };
    }
    // Only "shopify" has a real adapter today - see fetchShopifyInventory.
    // whEligibleUnits here is WH stock for every style/colour that's at
    // least a candidate for this channel (i.e. every row with WH data) -
    // there's no per-channel eligibility RULE in this codebase yet (no
    // "this style is Shopify-only" flag anywhere), so "eligible" is
    // currently just "WH has it at all."
    let liveSkus = 0;
    let sellableUnits = 0;
    let whEligibleUnits = 0;
    let missingUnits = 0;
    let mismatchUnits = 0;
    for (const r of rows) {
      if (r.whHasData) whEligibleUnits += r.whStock;
      if (r.onShopify && r.shopifySoh > 0) {
        liveSkus += 1;
        sellableUnits += r.shopifySoh;
      }
      if (r.whHasData && !(r.onShopify && r.shopifySoh > 0)) missingUnits += r.whStock;
      if (!r.match) mismatchUnits += Math.abs(r.diff);
    }
    return {
      channelId: ch.id,
      channelName: ch.name,
      active: true,
      liveSkus,
      sellableUnits,
      whEligibleUnits,
      missingUnits,
      mismatchUnits,
      availabilityPct: whEligibleUnits > 0 ? (sellableUnits / whEligibleUnits) * 100 : null,
    };
  });

  return {
    rows,
    availableGodowns: [...availableGodownsSet].sort((a, b) => a.localeCompare(b)),
    channelSummaries,
    totalWhStockValue,
  };
}
