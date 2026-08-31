/**
 * Channel Model -> Channel Type -> Channel Name hierarchy for /sale-summary's
 * redesigned drill-down table (2026-08-31). The data has a real 3-level
 * structure (3 Channel Model values, 14 Channel Type, 73 Channel Name — see
 * migration 0101's header) that the original flat "Channel Type breakdown"
 * table + separate "Top parties" table didn't expose at all.
 *
 * Every level's qty/gross/net is a SUM of its children (extensive columns).
 * No discount/markup % here — removed 2026-08-31, see aggregate.ts's header
 * for why (gross=taxable, net=after-tax; (gross-net)/gross is a tax-rate
 * artifact, not a real discount, and the correct basis differs party-by-
 * party) — do not reintroduce it on this table.
 *
 * `channel_name` is the hierarchy's leaf, NOT `party_name` — the screenshot
 * pivot table and migration 0101's header both describe the 3-level shape as
 * Model -> Type -> Channel Name (73 distinct values). `party_name` (817
 * distinct — a finer, less structured breakdown, e.g. individual counters
 * under one distributor) stays reachable via the page's existing search/
 * facet fields instead of becoming a 4th hierarchy level, per the redesign
 * brief: "the existing party quick-search can stay as a way to jump/filter
 * within this hierarchy rather than being a separate flat list."
 */

import { num, type ChannelSalesRow } from "./aggregate";

export type HierarchyLeafAgg = {
  channelModel: string;
  channelType: string;
  channelName: string;
  qty: number;
  gross: number;
  net: number;
};

/** Aggregates rows to one row per (channel_model, channel_type, channel_name) — the hierarchy's leaf grain. Reused for both the full-scope table data and the single-month slices growth is computed from. */
export function aggregateLeaves(rows: ChannelSalesRow[]): HierarchyLeafAgg[] {
  const map = new Map<string, HierarchyLeafAgg>();
  for (const r of rows) {
    const channelModel = r.channel_model || "(no channel model)";
    const channelType = r.channel_type || "(no channel type)";
    const channelName = r.channel_name || "(blank)";
    const key = `${channelModel} ${channelType} ${channelName}`;
    const cur = map.get(key) ?? { channelModel, channelType, channelName, qty: 0, gross: 0, net: 0 };
    cur.qty += num(r.total_quantity);
    cur.gross += num(r.gross_amount);
    cur.net += num(r.net_amount);
    map.set(key, cur);
  }
  return [...map.values()];
}

export type HierarchyRow = {
  id: string;
  level: 0 | 1 | 2; // 0 = Channel Model, 1 = Channel Type, 2 = Channel Name (leaf)
  label: string;
  channelModel: string;
  channelType: string | null; // null at model level
  channelName: string | null; // null above leaf level
  qty: number;
  gross: number;
  net: number;
  /** Distinct Channel Name count under this node — 1 at leaf level, always shown so a collapsed row still says how much it's hiding. */
  childCount: number;
  /**
   * Latest-month-vs-comparison-month % change for THIS node (not the full
   * scope total) — see SaleSummaryClient/comparison.ts for why growth is
   * always a single-month read even though qty/gross/net above are summed
   * over the whole selected month range. Measured on BOTH qty and gross
   * (2026-08-31, per Pankaj: "growth to be measure for both aspect qty and
   * value" — value here means TAXABLE value = gross_amount, not net, which
   * is after-tax and channel-dependent — see aggregate.ts's header). null
   * when no comparison is active, the node didn't exist in the comparison
   * month (a genuinely new channel — shown as "no comparison baseline", not
   * 0%), or the comparison month's value for this node was exactly zero.
   */
  qtyGrowthPct: number | null;
  grossGrowthPct: number | null;
  /** True once a comparison is active AND the comparison month had ANY data for this node's own scope (shared by both growth fields — presence/absence of the node in the comparison month doesn't depend on which metric you're looking at). Lets a cell distinguish "0% change" from "nothing to compare against". */
  hasComparisonBaseline: boolean;
};

/** Builds {qty, gross} growth% for one map key, from two (key -> {qty, gross}) maps. */
function growthFor(
  key: string,
  currentByKey: Map<string, { qty: number; gross: number }>,
  comparisonByKey: Map<string, { qty: number; gross: number }> | null
): { qtyGrowthPct: number | null; grossGrowthPct: number | null; hasComparisonBaseline: boolean } {
  if (comparisonByKey === null) return { qtyGrowthPct: null, grossGrowthPct: null, hasComparisonBaseline: false };
  const comparison = comparisonByKey.get(key);
  if (comparison === undefined) return { qtyGrowthPct: null, grossGrowthPct: null, hasComparisonBaseline: false };
  const current = currentByKey.get(key) ?? { qty: 0, gross: 0 };
  const pct = (curr: number, prev: number): number | null => (prev === 0 ? null : ((curr - prev) / Math.abs(prev)) * 100);
  return {
    qtyGrowthPct: pct(current.qty, comparison.qty),
    grossGrowthPct: pct(current.gross, comparison.gross),
    hasComparisonBaseline: true,
  };
}

function sumByKey(leaves: HierarchyLeafAgg[], keyOf: (l: HierarchyLeafAgg) => string): Map<string, { qty: number; gross: number }> {
  const map = new Map<string, { qty: number; gross: number }>();
  for (const l of leaves) {
    const cur = map.get(keyOf(l)) ?? { qty: 0, gross: 0 };
    cur.qty += l.qty;
    cur.gross += l.gross;
    map.set(keyOf(l), cur);
  }
  return map;
}

const leafKey = (l: HierarchyLeafAgg) => `${l.channelModel} ${l.channelType} ${l.channelName}`;
const typeKey = (l: HierarchyLeafAgg) => `${l.channelModel} ${l.channelType}`;
const modelKey = (l: HierarchyLeafAgg) => l.channelModel;

/**
 * Builds the flat, tree-ordered row list (Model, then its Type rows in net
 * order, then each Type's leaf rows in net order) the table renders. Sorted
 * net-descending at every level — the same "biggest first" convention
 * computeBreakdown already uses — rather than alphabetically, since this is
 * meant to read as a management ranking, not a directory.
 *
 * `growthLeaves` — when provided — supplies the single-latest-month current
 * and comparison leaf sets growthPct is computed from (see this file's
 * header for why growth doesn't use `scopeLeaves`' own, possibly
 * multi-month, totals).
 */
export function buildHierarchyRows(
  scopeLeaves: HierarchyLeafAgg[],
  growthLeaves: { currentMonthLeaves: HierarchyLeafAgg[]; comparisonMonthLeaves: HierarchyLeafAgg[] | null } | null
): HierarchyRow[] {
  const currentByLeafKey = growthLeaves ? sumByKey(growthLeaves.currentMonthLeaves, leafKey) : new Map<string, { qty: number; gross: number }>();
  const currentByTypeKey = growthLeaves ? sumByKey(growthLeaves.currentMonthLeaves, typeKey) : new Map<string, { qty: number; gross: number }>();
  const currentByModelKey = growthLeaves ? sumByKey(growthLeaves.currentMonthLeaves, modelKey) : new Map<string, { qty: number; gross: number }>();
  const comparisonByLeafKey = growthLeaves?.comparisonMonthLeaves ? sumByKey(growthLeaves.comparisonMonthLeaves, leafKey) : null;
  const comparisonByTypeKey = growthLeaves?.comparisonMonthLeaves ? sumByKey(growthLeaves.comparisonMonthLeaves, typeKey) : null;
  const comparisonByModelKey = growthLeaves?.comparisonMonthLeaves ? sumByKey(growthLeaves.comparisonMonthLeaves, modelKey) : null;

  // Group scopeLeaves into Model -> Type -> [leaves], summing as we go.
  type TypeBucket = { channelType: string; qty: number; gross: number; net: number; leaves: HierarchyLeafAgg[] };
  type ModelBucket = { channelModel: string; qty: number; gross: number; net: number; types: Map<string, TypeBucket> };
  const models = new Map<string, ModelBucket>();

  for (const leaf of scopeLeaves) {
    let model = models.get(leaf.channelModel);
    if (!model) {
      model = { channelModel: leaf.channelModel, qty: 0, gross: 0, net: 0, types: new Map() };
      models.set(leaf.channelModel, model);
    }
    model.qty += leaf.qty;
    model.gross += leaf.gross;
    model.net += leaf.net;

    let type = model.types.get(leaf.channelType);
    if (!type) {
      type = { channelType: leaf.channelType, qty: 0, gross: 0, net: 0, leaves: [] };
      model.types.set(leaf.channelType, type);
    }
    type.qty += leaf.qty;
    type.gross += leaf.gross;
    type.net += leaf.net;
    type.leaves.push(leaf);
  }

  const out: HierarchyRow[] = [];
  const sortedModels = [...models.values()].sort((a, b) => b.net - a.net);
  for (const model of sortedModels) {
    const modelChildCount = new Set([...model.types.values()].flatMap((t) => t.leaves.map((l) => l.channelName))).size;
    const mg = growthFor(model.channelModel, currentByModelKey, comparisonByModelKey);
    out.push({
      id: `model:${model.channelModel}`,
      level: 0,
      label: model.channelModel,
      channelModel: model.channelModel,
      channelType: null,
      channelName: null,
      qty: model.qty,
      gross: model.gross,
      net: model.net,
      childCount: modelChildCount,
      qtyGrowthPct: mg.qtyGrowthPct,
      grossGrowthPct: mg.grossGrowthPct,
      hasComparisonBaseline: mg.hasComparisonBaseline,
    });

    const sortedTypes = [...model.types.values()].sort((a, b) => b.net - a.net);
    for (const type of sortedTypes) {
      const tKey = `${model.channelModel} ${type.channelType}`;
      const tg = growthFor(tKey, currentByTypeKey, comparisonByTypeKey);
      out.push({
        id: `type:${tKey}`,
        level: 1,
        label: type.channelType,
        channelModel: model.channelModel,
        channelType: type.channelType,
        channelName: null,
        qty: type.qty,
        gross: type.gross,
        net: type.net,
        childCount: type.leaves.length,
        qtyGrowthPct: tg.qtyGrowthPct,
        grossGrowthPct: tg.grossGrowthPct,
        hasComparisonBaseline: tg.hasComparisonBaseline,
      });

      const sortedLeaves = [...type.leaves].sort((a, b) => b.net - a.net);
      for (const leaf of sortedLeaves) {
        const lKey = leafKey(leaf);
        const lg = growthFor(lKey, currentByLeafKey, comparisonByLeafKey);
        out.push({
          id: `leaf:${lKey}`,
          level: 2,
          label: leaf.channelName,
          channelModel: model.channelModel,
          channelType: type.channelType,
          channelName: leaf.channelName,
          qty: leaf.qty,
          gross: leaf.gross,
          net: leaf.net,
          childCount: 1,
          qtyGrowthPct: lg.qtyGrowthPct,
          grossGrowthPct: lg.grossGrowthPct,
          hasComparisonBaseline: lg.hasComparisonBaseline,
        });
      }
    }
  }

  return out;
}
