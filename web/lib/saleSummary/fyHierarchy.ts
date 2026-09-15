/**
 * Channel Model -> Channel Type -> Channel Name hierarchy, PIVOTED by
 * Financial Year (2026-09-15) — the "all years at a glance" table Pankaj
 * asked for, sitting above the page's own month-range-filtered content.
 *
 * Deliberately independent of the page's date-range/facet state: the whole
 * point is a full-history year-over-year read, so this reads the ENTIRE
 * table (all financial years present), not whatever range MonthRangePicker
 * currently has selected. Same hierarchy grain as hierarchy.ts's hierarchy
 * (Model -> Type -> Channel Name, leaf = channel_name not party_name), but
 * each node carries one {qty, gross} cell PER financial year rather than a
 * single flat sum — and only qty/gross (taxable), no net and no growth%,
 * per Pankaj's own ask ("year wise qty - gross Val (Taxable) only").
 *
 * Financial year is derived from bill_month, not week_start/week_end —
 * a row that was already MERGED across the fiscal-year boundary (see
 * parseChannelSummaryWorkbook.ts's mergeDuplicateKeyRows) has no way to be
 * split back into "the March portion" and "the April portion"; bill_month
 * is the source file's own convention for which side that whole week counts
 * toward, so this stays consistent with it rather than re-deriving a
 * different answer from the day-level dates.
 */

import { financialYearOf, num, type ChannelSalesRow } from "./aggregate";

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

/** Every distinct financial year present in `rows`, chronological ascending (oldest first). */
export function financialYearsPresent(rows: ChannelSalesRow[]): string[] {
  const set = new Set(rows.map((r) => financialYearOf(r.bill_month)));
  // "FY2021-22" sorts correctly as a plain string — the 4-digit start year is
  // always in the same position and zero-padded by construction.
  return [...set].sort();
}

const emptyCell = (): FyCell => ({ qty: 0, gross: 0 });

function addRowInto(cell: FyCell, r: ChannelSalesRow): void {
  cell.qty += num(r.total_quantity);
  cell.gross += num(r.gross_amount);
}

function ensureFyCell(byFy: Map<string, FyCell>, fy: string): FyCell {
  let c = byFy.get(fy);
  if (!c) {
    c = emptyCell();
    byFy.set(fy, c);
  }
  return c;
}

/** Sums a node's cells across every FY — the ranking basis for "biggest first" sort, same convention hierarchy.ts's net-descending sort uses (gross is this table's only value column). */
const totalGross = (byFy: Map<string, FyCell>): number => [...byFy.values()].reduce((s, c) => s + c.gross, 0);

function toRecord(byFy: Map<string, FyCell>, financialYears: string[]): Record<string, FyCell> {
  const rec: Record<string, FyCell> = {};
  for (const fy of financialYears) rec[fy] = byFy.get(fy) ?? emptyCell();
  return rec;
}

export function buildFyHierarchyRows(rows: ChannelSalesRow[], financialYears: string[]): FyHierarchyRow[] {
  type TypeBucket = { channelType: string; byFy: Map<string, FyCell>; names: Map<string, Map<string, FyCell>> };
  type ModelBucket = { channelModel: string; byFy: Map<string, FyCell>; types: Map<string, TypeBucket> };
  const models = new Map<string, ModelBucket>();

  for (const r of rows) {
    const channelModel = r.channel_model || "(no channel model)";
    const channelType = r.channel_type || "(no channel type)";
    const channelName = r.channel_name || "(blank)";
    const fy = financialYearOf(r.bill_month);

    let model = models.get(channelModel);
    if (!model) {
      model = { channelModel, byFy: new Map(), types: new Map() };
      models.set(channelModel, model);
    }
    addRowInto(ensureFyCell(model.byFy, fy), r);

    let type = model.types.get(channelType);
    if (!type) {
      type = { channelType, byFy: new Map(), names: new Map() };
      model.types.set(channelType, type);
    }
    addRowInto(ensureFyCell(type.byFy, fy), r);

    let name = type.names.get(channelName);
    if (!name) {
      name = new Map<string, FyCell>();
      type.names.set(channelName, name);
    }
    addRowInto(ensureFyCell(name, fy), r);
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
