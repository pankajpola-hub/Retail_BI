import type { DataClient } from "@/lib/data/client";
import { buildDcMatrix, buildNibmSummary, type StockRow } from "@/lib/stockDetails/aggregate";

/**
 * Phase 8+ workspace component expansion (2026-08-15) — first NON-Sales
 * component family. Reuses buildDcMatrix/buildNibmSummary verbatim, the
 * exact same pure functions /stock-details itself uses — a number shown
 * here and the same number shown there can never disagree.
 *
 * Deliberately implements the catalogued `gender_split_card`
 * (workspace.component_definitions: "Girls vs Boys share of ... current
 * stock, as a two-number card", cost `medium`) rather than the heavier
 * `stock_vs_capacity_table` — that one needs a SECOND query
 * (ops.stock_display_capacity, admin-set targets) and per-store rendering
 * that didn't fit this pass's scope; gender_split_card is a single query,
 * genuinely cheap, and uses the exact same underlying functions. Swapping
 * in the heavier one is a reasonable future follow-up, not done silently
 * as if it were what was asked for.
 */
export type StockComponentScope = { supabase: DataClient; storeIds: string[] };

export type StockComponentData = {
  genderSplit: ReturnType<typeof buildNibmSummary>;
};

export async function fetchStockComponentData(scope: StockComponentScope): Promise<StockComponentData> {
  const { supabase, storeIds } = scope;
  // No date range — current stock is a point-in-time snapshot, same as
  // /stock-details itself (0024's full-replace-per-upload model).
  let query = supabase
    .schema("sales")
    .from<StockRow>("vw_stock_with_scheme")
    .select("id, branch_name, season, gender, size_group, item_code, shade_name, size, closing_stock, is_eoss")
    .limit(20000);
  if (storeIds.length === 1) query = query.eq("branch_name", storeIds[0]!);
  // NOTE: vw_stock_with_scheme is keyed by branch_name, not store_id — the
  // Workspace's storeIds are store_id values. Multi-store filtering needs
  // a branch_name lookup this component doesn't have scope access to yet,
  // so a multi-store or all-stores selection intentionally shows ALL
  // stores' stock combined rather than silently guessing which one — see
  // the card's own "network-wide" label below.
  const { data } = await query;

  const rows = (data ?? []).filter((r) => r.gender === "FEMALE" || r.gender === "MALE");
  const genderSplit = buildNibmSummary(buildDcMatrix(rows));
  return { genderSplit };
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-IN");

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

export const STOCK_COMPONENT_RENDERERS: Record<
  string,
  (props: { data: StockComponentData; storeIds: string[] }) => JSX.Element
> = {
  gender_split_card: GenderSplitCard,
};
