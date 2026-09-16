/**
 * Channel Model -> Channel Type -> Channel Name hierarchy, PIVOTED by
 * Financial Year (2026-09-15) — the "all years at a glance" table Pankaj
 * asked for, sitting at the bottom of the page below its own month-range-
 * filtered content.
 *
 * Reads sales.vw_channel_sales_fy_summary (migration 0106), NOT the raw
 * per-row sales.vw_channel_sales_summary — that view already does the
 * SUM(qty)/SUM(gross) GROUP BY (financial_year, channel_model, channel_type,
 * channel_name) in Postgres. Building this same table from raw rows meant
 * fetching the whole history (43,956+ rows at last count) through
 * fetchAllRows' sequential ~1000-row-per-page loop — tens of round trips —
 * just to re-sum it in Node; the pre-aggregated view returns at most a few
 * hundred rows in one request. See 0106's own header for the full story.
 *
 * Only qty/gross (taxable), no net and no growth% — per Pankaj's own ask
 * ("year wise qty - gross Val (Taxable) only").
 */

import { num } from "./aggregate";

export type FyCell = { qty: number; gross: number };

export type FyHierarchyRow = {
  id: string;
  level: 0 | 1 | 2; // 0 = Channel Model, 1 = Channel Type, 2 = Channel Name (leaf)
  label: string;
  channelModel: string;
  channelType: string | null;
  channelName: string | null;
  /** Distinct Channel Name count under this node — 1 at leaf level. */
  childCount: number;
  /** One cell per entry in the `financialYears` list this row set was built with, in that same order. */
  byFy: Record<string, FyCell>;
};

/** One row of sales.vw_channel_sales_fy_summary (0106) — already grouped, not per-transaction. */
export type FyAggRow = {
  financial_year: string;
  channel_model: string;
  channel_type: string;
  channel_name: string;
  qty: number | string;
  gross: number | string;
};

/** Every distinct financial year present in `rows`, chronological ascending (oldest first). */
export function financialYearsFromAgg(rows: FyAggRow[]): string[] {
  // "FY2021-22" sorts correctly as a plain string — the 4-digit start year is
  // always in the same position and zero-padded by construction.
  return [...new Set(rows.map((r) => r.financial_year))].sort();
}

const emptyCell = (): FyCell => ({ qty: 0, gross: 0 });

/** Sums a node's cells across every FY — the ranking basis for "biggest first" sort, same convention hierarchy.ts's net-descending sort uses (gross is this table's only value column). */
const totalGross = (byFy: Map<string, FyCell>): number => [...byFy.values()].reduce((s, c) => s + c.gross, 0);

function toRecord(byFy: Map<string, FyCell>, financialYears: string[]): Record<string, FyCell> {
  const rec: Record<string, FyCell> = {};
  for (const fy of financialYears) rec[fy] = byFy.get(fy) ?? emptyCell();
  return rec;
}

/** Builds the Model -> Type -> Name tree from already-grouped rows (one row = one (fy, model, type, name) cell — no further row-level summing needed). */
export function buildFyHierarchyRowsFromAgg(rows: FyAggRow[], financialYears: string[]): FyHierarchyRow[] {
  type TypeBucket = { channelType: string; byFy: Map<string, FyCell>; names: Map<string, Map<string, FyCell>> };
  type ModelBucket = { channelModel: string; byFy: Map<string, FyCell>; types: Map<string, TypeBucket> };
  const models = new Map<string, ModelBucket>();

  for (const r of rows) {
    const channelModel = r.channel_model;
    const channelType = r.channel_type;
    const channelName = r.channel_name;
    const fy = r.financial_year;
    const cell: FyCell = { qty: num(r.qty), gross: num(r.gross) };

    let model = models.get(channelModel);
    if (!model) {
      model = { channelModel, byFy: new Map(), types: new Map() };
      models.set(channelModel, model);
    }
    const modelCell = model.byFy.get(fy) ?? emptyCell();
    modelCell.qty += cell.qty;
    modelCell.gross += cell.gross;
    model.byFy.set(fy, modelCell);

    let type = model.types.get(channelType);
    if (!type) {
      type = { channelType, byFy: new Map(), names: new Map() };
      model.types.set(channelType, type);
    }
    const typeCell = type.byFy.get(fy) ?? emptyCell();
    typeCell.qty += cell.qty;
    typeCell.gross += cell.gross;
    type.byFy.set(fy, typeCell);

    // Leaf grain is already (fy, model, type, name) in the source view, so
    // there's at most one row per name+fy — but a leaf can still appear
    // more than once across fys, hence still a Map keyed by fy here too.
    let name = type.names.get(channelName);
    if (!name) {
      name = new Map<string, FyCell>();
      type.names.set(channelName, name);
    }
    const nameCell = name.get(fy) ?? emptyCell();
    nameCell.qty += cell.qty;
    nameCell.gross += cell.gross;
    name.set(fy, nameCell);
  }

  const out: FyHierarchyRow[] = [];
  const sortedModels = [...models.values()].sort((a, b) => totalGross(b.byFy) - totalGross(a.byFy));
  for (const model of sortedModels) {
    const modelChildCount = [...model.types.values()].reduce((s, t) => s + t.names.size, 0);
    out.push({
      id: `model:${model.channelModel}`,
      level: 0,
      label: model.channelModel,
      channelModel: model.channelModel,
      channelType: null,
      channelName: null,
      childCount: modelChildCount,
      byFy: toRecord(model.byFy, financialYears),
    });

    const sortedTypes = [...model.types.values()].sort((a, b) => totalGross(b.byFy) - totalGross(a.byFy));
    for (const type of sortedTypes) {
      out.push({
        id: `type:${model.channelModel} ${type.channelType}`,
        level: 1,
        label: type.channelType,
        channelModel: model.channelModel,
        channelType: type.channelType,
        channelName: null,
        childCount: type.names.size,
        byFy: toRecord(type.byFy, financialYears),
      });

      const sortedNames = [...type.names.entries()].sort((a, b) => totalGross(b[1]) - totalGross(a[1]));
      for (const [channelName, byFy] of sortedNames) {
        out.push({
          id: `leaf:${model.channelModel} ${type.channelType} ${channelName}`,
          level: 2,
          label: channelName,
          channelModel: model.channelModel,
          channelType: type.channelType,
          channelName,
          childCount: 1,
          byFy: toRecord(byFy, financialYears),
        });
      }
    }
  }

  return out;
}
