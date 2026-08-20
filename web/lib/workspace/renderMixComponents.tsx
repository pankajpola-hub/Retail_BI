import type { DataClient } from "@/lib/data/client";
import { KpiCard } from "@/components/ui/KpiCard";
import { computeSaleStockMix, MIX_STATUS_META, type MixRow, type MixStatus } from "@/lib/replenishment/mix";

/**
 * Second non-Sales workspace component family (2026-08-15). Wraps
 * lib/replenishment/mix.ts's computeSaleStockMix verbatim — the exact
 * function /sale-stock-mix itself calls, so a number here can never
 * disagree with that page.
 *
 * Cost note, stated plainly (matches the registry's own `cost: high` on
 * sale_stock_mix_table): computeSaleStockMix independently pulls up to
 * 40,000 stock rows + 100,000 sale rows — this is a genuinely expensive
 * SECOND fetch on top of whatever the Sales components in the same
 * workspace already pull. page.tsx only calls this when a mix component is
 * actually present (needsMixData), same "pay only for what's added"
 * pattern the Sales fetch already uses.
 *
 * Scope note, stated plainly: computeSaleStockMix takes a SINGLE storeId
 * (or "" for all stores), not a list — the Workspace's store filter is a
 * list. When exactly one store is selected, that store is used; otherwise
 * this shows ALL stores combined and says so, rather than silently
 * misrepresenting a multi-store selection as single-store data.
 */
export type MixComponentScope = { supabase: DataClient; storeIds: string[] };

export type MixComponentData = {
  rows: MixRow[];
  totalRows: number;
  usedStoreId: string;
  /**
   * Status counts across the FULL row set, not just the top-N slice below —
   * feeds mix_status_kpi_grid (2026-08-20). Computed here rather than by a
   * second query: computeSaleStockMix already returns every row, this was
   * just never tallied before the top-15 cap discarded the rest.
   */
  statusCounts: Record<MixStatus, number>;
};

const TOP_N = 15;

export async function fetchMixComponentData(scope: MixComponentScope): Promise<MixComponentData> {
  const { supabase, storeIds } = scope;
  const usedStoreId = storeIds.length === 1 ? storeIds[0]! : "";
  const { rows } = await computeSaleStockMix(supabase, { storeId: usedStoreId, salesPeriodDays: 30 });

  const statusCounts: Record<MixStatus, number> = {
    high_priority: 0,
    opportunity: 0,
    balanced: 0,
    stock_heavy: 0,
    overstocked: 0,
  };
  for (const r of rows) statusCounts[r.status]++;

  // Highest-priority gaps first (same sort computeSaleStockMix already
  // returns — descending mixGapPts), capped to a tile-sized top N rather
  // than dumping all 1,000+ style-colors into a workspace card.
  return { rows: rows.slice(0, TOP_N), totalRows: rows.length, usedStoreId, statusCounts };
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-IN");
const pct = (n: number) => `${n.toFixed(1)}%`;

export function SaleStockMixTable({ data, storeIds }: { data: MixComponentData; storeIds: string[] }) {
  return (
    <div className="overflow-y-auto">
      {storeIds.length !== 1 && (
        <p className="mb-2 text-[11px] text-ink-3">
          Showing all stores combined (last 30 days) — single-store selection narrows this to that store.
        </p>
      )}
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-line-soft bg-surface-2 text-left text-[10px] uppercase tracking-wide text-ink-3">
            <th className="px-2 py-1.5">Style / Color</th>
            <th className="px-2 py-1.5 text-right">Store SOH</th>
            <th className="px-2 py-1.5 text-right">WH SOH</th>
            <th className="px-2 py-1.5 text-right">Mix Gap</th>
            <th className="px-2 py-1.5">Status</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => {
            const meta = MIX_STATUS_META[r.status];
            return (
              <tr key={`${r.styleNo}-${r.color}`} className="border-b border-line-soft last:border-0">
                <td className="px-2 py-1.5 font-mono text-[11px]">
                  {r.styleNo} <span className="text-ink-3">{r.color}</span>
                </td>
                <td className="px-2 py-1.5 text-right font-mono">{fmt(r.soh)}</td>
                <td className="px-2 py-1.5 text-right font-mono">{fmt(r.warehouseAvailable)}</td>
                <td
                  className={`px-2 py-1.5 text-right font-mono font-semibold ${
                    r.mixGapPts > 0 ? "text-good" : r.mixGapPts < 0 ? "text-crit" : "text-ink-3"
                  }`}
                >
                  {r.mixGapPts >= 0 ? "+" : ""}
                  {pct(r.mixGapPts)}
                </td>
                <td className={`px-2 py-1.5 ${meta.className}`}>
                  {meta.dot} {meta.label}
                </td>
              </tr>
            );
          })}
          {data.rows.length === 0 && (
            <tr>
              <td colSpan={5} className="px-2 py-4 text-center text-ink-3">
                No style-colors in this scope.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {data.totalRows > data.rows.length && (
        <p className="mt-1.5 text-[11px] text-ink-3">
          Top {data.rows.length} of {fmt(data.totalRows)} by mix gap — full list on Sale vs Stock Mix.
        </p>
      )}
    </div>
  );
}

/**
 * 2026-08-20 — second Mix-family component. Counts across the full row set
 * (see MixComponentData.statusCounts) rather than the top-15-row slice
 * SaleStockMixTable shows, so the two components can be dropped in the same
 * workspace without one silently undercounting the other.
 */
export function MixStatusKpiGrid({ data, storeIds }: { data: MixComponentData; storeIds: string[] }) {
  const order: MixStatus[] = ["high_priority", "opportunity", "balanced", "stock_heavy", "overstocked"];
  return (
    <div>
      {storeIds.length !== 1 && (
        <p className="mb-2 text-[11px] text-ink-3">
          Showing all stores combined (last 30 days) — single-store selection narrows this to that store.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {order.map((status) => {
          const meta = MIX_STATUS_META[status];
          return <KpiCard key={status} label={`${meta.dot} ${meta.label}`} value={fmt(data.statusCounts[status])} />;
        })}
      </div>
    </div>
  );
}

export const MIX_COMPONENT_RENDERERS: Record<
  string,
  (props: { data: MixComponentData; storeIds: string[] }) => JSX.Element
> = {
  sale_stock_mix_table: SaleStockMixTable,
  mix_status_kpi_grid: MixStatusKpiGrid,
};
