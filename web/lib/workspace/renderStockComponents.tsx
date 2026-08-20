import type { DataClient } from "@/lib/data/client";
import { CapacityEditorCard } from "@/app/(stock-details)/stock-details/capacity-editor";
import { StockVsCapacityGrid } from "@/app/(stock-details)/stock-details/StockVsCapacityGrid";
import {
  buildDcMatrix,
  buildNibmSummary,
  buildCapacityPlan,
  buildCapacityGridRows,
  groupByGenderAnd,
  GENDER_LABELS,
  type StockRow,
  type CapacityRow,
  type CapacityGridRow,
  type CapacityBlock,
  type GroupedBreakdown,
  type Gender,
} from "@/lib/stockDetails/aggregate";

/**
 * Stock-family workspace components. `gender_split_card` (2026-08-15) reuses
 * buildDcMatrix/buildNibmSummary verbatim, the same functions
 * /stock-details itself uses. Extended 2026-08-20 with
 * `stock_vs_capacity_table` (reuses buildCapacityGridRows/
 * StockVsCapacityGrid.tsx, the exact AG Grid component that page's own
 * "current stock vs planned capacity" section uses) and
 * `stock_breakdown_table` (reuses groupByGenderAnd, same as that page's
 * BreakdownSection — defaulted to the Season dimension, since there's no
 * per-tile "choose a dimension" config surface yet; stated plainly rather
 * than silently picking one and calling it done).
 */
export type StockComponentScope = { supabase: DataClient; storeIds: string[]; canEditCapacity: boolean };

type StoreRow = { store_id: string; store_name: string; branch_name_erp: string };

export type StockComponentData = {
  genderSplit: ReturnType<typeof buildNibmSummary>;
  seasonBreakdown: Record<Gender, GroupedBreakdown[]>;
  capacityGridRows: CapacityGridRow[];
  /**
   * capacity_editor needs exactly ONE store to edit — undefined when the
   * workspace's scope isn't exactly one store, in which case the tile says
   * so plainly instead of guessing which store to show an edit form for.
   */
  editableStore: { storeId: string; storeName: string; blocks: CapacityBlock[] } | null;
  namesByUserId: Record<string, string>;
  canEditCapacity: boolean;
};

export async function fetchStockComponentData(scope: StockComponentScope): Promise<StockComponentData> {
  const { supabase, storeIds, canEditCapacity } = scope;

  // stock_vs_capacity_table needs the full store list (branch_name_erp) to
  // resolve which stock rows belong to which store — a second, independent
  // query from gender_split_card's own stock pull below.
  const { data: storesData } = await supabase
    .schema("core")
    .from<StoreRow>("stores")
    .select("store_id, store_name, branch_name_erp")
    .order("store_id");
  const storeList = (storesData ?? []).filter((s) => s.store_id !== "BO-004");
  const storesInScope = storeIds.length > 0 ? storeList.filter((s) => storeIds.includes(s.store_id)) : storeList;

  // No date range — current stock is a point-in-time snapshot, same as
  // /stock-details itself (0024's full-replace-per-upload model).
  let stockQuery = supabase
    .schema("sales")
    .from<StockRow>("vw_stock_with_scheme")
    .select("id, branch_name, season, gender, size_group, item_code, shade_name, size, closing_stock, is_eoss")
    .limit(20000);
  if (storeIds.length === 1) stockQuery = stockQuery.eq("branch_name", storeList.find((s) => s.store_id === storeIds[0])?.branch_name_erp ?? storeIds[0]!);
  const { data: stockData } = await stockQuery;
  const stockRows = (stockData ?? []).filter((r) => r.gender === "FEMALE" || r.gender === "MALE");

  const { data: capacityData } = await supabase
    .schema("ops")
    .from<CapacityRow>("stock_display_capacity")
    .select("store_id, gender, age_segment, base_capacity, buffer_pct, fresh_pct, updated_by, updated_at");
  const capacityRows = capacityData ?? [];

  const genderSplit = buildNibmSummary(buildDcMatrix(stockRows));
  const seasonBreakdown: Record<Gender, GroupedBreakdown[]> = {
    FEMALE: groupByGenderAnd(stockRows, (r) => r.season, "FEMALE"),
    MALE: groupByGenderAnd(stockRows, (r) => r.season, "MALE"),
  };
  const capacityGridRows = buildCapacityGridRows(
    storesInScope,
    (s) => buildCapacityPlan(capacityRows.filter((r) => r.store_id === s.store_id)),
    (s) => buildDcMatrix(stockRows.filter((r) => r.branch_name === s.branch_name_erp))
  );

  // capacity_editor: only a single-store scope resolves to one editable
  // store. editorProfiles is a small, cheap lookup — only fetched when
  // there's actually a store to edit.
  let editableStore: StockComponentData["editableStore"] = null;
  let namesByUserId: Record<string, string> = {};
  if (storesInScope.length === 1) {
    const store = storesInScope[0]!;
    const blocks = buildCapacityPlan(capacityRows.filter((r) => r.store_id === store.store_id));
    editableStore = { storeId: store.store_id, storeName: store.store_name, blocks };
    const editorIds = [...new Set(blocks.map((b) => b.updatedBy).filter((id): id is string => !!id))];
    if (editorIds.length > 0) {
      const { data: editorProfiles } = await supabase
        .schema("core")
        .from<{ user_id: string; full_name: string }>("profiles")
        .select("user_id, full_name")
        .in("user_id", editorIds);
      namesByUserId = Object.fromEntries((editorProfiles ?? []).map((p) => [p.user_id, p.full_name]));
    }
  }

  return { genderSplit, seasonBreakdown, capacityGridRows, editableStore, namesByUserId, canEditCapacity };
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-IN");
const pct = (n: number) => `${n.toFixed(1)}%`;

export function GenderSplitCard({ data, storeIds }: { data: StockComponentData; storeIds: string[] }) {
  return (
    <div>
      {storeIds.length !== 1 && (
        <p className="mb-2 text-[11px] text-ink-3">
          Showing all stores combined — single-store selection narrows this card.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        {data.genderSplit.map((g) => (
          <div key={g.gender} className="border border-line-soft bg-surface-2 px-3 py-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-3">{g.label}</div>
            <div className="mt-1 font-mono text-lg font-semibold text-ink">{fmt(g.total)}</div>
            <div className="text-[11px] text-ink-3">{g.sharePct.toFixed(1)}% of current stock</div>
          </div>
        ))}
        {data.genderSplit.every((g) => g.total === 0) && (
          <p className="col-span-2 py-4 text-center text-sm text-ink-3">No stock rows for this scope.</p>
        )}
      </div>
    </div>
  );
}

/**
 * Reuses StockVsCapacityGrid.tsx directly — the same client component
 * `/stock-details` itself renders — rather than rebuilding AG Grid column
 * defs here. Column defs contain functions (valueFormatter/cellClass), and
 * functions can't cross the server→client component boundary as props; see
 * ReplenishmentRecommendationsTable's header comment for the same lesson,
 * caught by the same live test.
 */
export function StockVsCapacityTable({ data }: { data: StockComponentData }) {
  return <StockVsCapacityGrid rows={data.capacityGridRows} />;
}

export function StockBreakdownTable({ data }: { data: StockComponentData }) {
  return (
    <div>
      <p className="mb-2 text-[11px] text-ink-3">Season-wise stock (default dimension — not yet configurable per tile).</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {(["FEMALE", "MALE"] as Gender[]).map((gender) => (
          <div key={gender} className="overflow-x-auto border border-line-soft">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-line-soft bg-surface-2 text-left text-[10px] uppercase tracking-wide text-ink-3">
                  <th className="px-2 py-1.5">{GENDER_LABELS[gender]}</th>
                  <th className="px-2 py-1.5 text-right">Units</th>
                  <th className="px-2 py-1.5 text-right">Fresh% / EOSS%</th>
                </tr>
              </thead>
              <tbody>
                {data.seasonBreakdown[gender].slice(0, 8).map((g) => (
                  <tr key={g.key} className="border-b border-line-soft last:border-0">
                    <td className="px-2 py-1.5">{g.label}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{fmt(g.total)}</td>
                    <td className="px-2 py-1.5 text-right font-mono">
                      {pct(g.freshPct)} / <span className={g.eossPct >= 70 ? "text-crit" : ""}>{pct(g.eossPct)}</span>
                    </td>
                  </tr>
                ))}
                {data.seasonBreakdown[gender].length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-2 py-2 text-ink-3">No stock.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Reuses CapacityEditorCard verbatim — the exact same client component and
 * server action (`setStoreDisplayCapacity`, independently re-checked
 * ho_admin/super_admin at the database layer, not just page-gated) that
 * `/stock-details` itself uses. `canEditCapacity` here only controls
 * whether the Save button renders — the real authorization boundary is the
 * server action's own role re-check, so a caller who isn't actually admin
 * can't write even if this were somehow miscomputed.
 */
export function CapacityEditorTile({ data }: { data: StockComponentData }) {
  if (!data.editableStore) {
    return (
      <p className="text-sm text-ink-3">
        Select exactly one store in the workspace&apos;s filter to edit its display capacity.
      </p>
    );
  }
  return (
    <CapacityEditorCard
      storeId={data.editableStore.storeId}
      storeName={data.editableStore.storeName}
      blocks={data.editableStore.blocks}
      namesByUserId={data.namesByUserId}
      canEdit={data.canEditCapacity}
    />
  );
}

export const STOCK_COMPONENT_RENDERERS: Record<
  string,
  (props: { data: StockComponentData; storeIds: string[] }) => JSX.Element
> = {
  gender_split_card: GenderSplitCard,
  stock_vs_capacity_table: StockVsCapacityTable,
  stock_breakdown_table: StockBreakdownTable,
  capacity_editor: CapacityEditorTile,
};
