import type { DataClient } from "@/lib/data/client";
import { KpiCard } from "@/components/ui/KpiCard";
import { ReplenishmentGrid } from "@/app/(replenishment)/replenishment/ReplenishmentGrid";
import {
  computeReplenishmentRows,
  computeReplenishmentKpis,
  computeTopSupplyMoves,
  fmt,
  fmt1,
  type ReplenishmentAssumptions,
  type Row,
  type Trend,
} from "@/lib/replenishment/compute";

/**
 * Third non-Sales workspace component family (2026-08-15/20) — now all 3
 * registered `replenishment`-category components:
 * `replenishment_kpi_grid`, `top_supply_moves_table`,
 * `replenishment_recommendations_table`. All 3 share ONE
 * `computeReplenishmentRows()` call (the same function `/replenishment`
 * itself calls, with that page's own default what-if assumptions — no
 * per-tile what-if UI), gated by `needsReplenishmentData` in page.tsx —
 * adding all 3 to one workspace still only runs the 40k/100k-row engine
 * ONCE, not three times.
 *
 * `replenishment_recommendations_table` is the registry's own most
 * expensive/interactive entry — it reuses ReplenishmentGrid.tsx, the exact
 * AG Grid + Dialog-drilldown component the standalone page uses, fed the
 * full row set (capped in height, not row count — AG Grid virtualizes).
 *
 * Scope note: network-wide, unfiltered by the workspace's store selector —
 * matches `/replenishment` itself, whose KPIs and top-supply-moves are
 * computed over the FULL row set before its own store/priority/action
 * filters apply.
 */
export type ReplenishmentComponentScope = { supabase: DataClient };
export type ReplenishmentComponentData = { rows: Row[]; totalWarehouseUnits: number };

// Same defaults ReplenishmentContent (app/(replenishment)/replenishment/page.tsx)
// falls back to when no ?targetCover/?leadTime/etc. is in the URL.
const DEFAULT_ASSUMPTIONS: ReplenishmentAssumptions = {
  targetCoverDays: 21,
  leadTimeDays: 5,
  safetyDays: 3,
  scoreWeights: { stockoutRisk: 25, velocity: 25, cover: 15, salesValue: 15, trend: 10, productivity: 10 },
};

export async function fetchReplenishmentComponentData(scope: ReplenishmentComponentScope): Promise<ReplenishmentComponentData> {
  const { rows, totalWarehouseUnits } = await computeReplenishmentRows(scope.supabase, DEFAULT_ASSUMPTIONS);
  return { rows, totalWarehouseUnits };
}

const INR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

export function ReplenishmentKpiGrid({ data }: { data: ReplenishmentComponentData }) {
  const k = computeReplenishmentKpis(data.rows);
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <KpiCard label="Need replenishment" value={fmt(k.needsReplenishment)} />
      <KpiCard label="Units required" value={fmt(k.unitsRequired)} />
      <KpiCard label="Critical" value={fmt(k.criticalCount)} />
      <KpiCard label="Stores at risk" value={fmt(k.storesAtRisk)} />
      <KpiCard label="Warehouse available" value={fmt(data.totalWarehouseUnits)} />
      <KpiCard label="Exhausted" value={fmt(k.exhaustedCount)} />
    </div>
  );
}

const TREND_LABEL: Record<Trend, { label: string; className: string }> = {
  accelerating: { label: "↑ Accelerating", className: "text-good" },
  stable: { label: "→ Stable", className: "text-ink-3" },
  declining: { label: "↓ Declining", className: "text-crit" },
};

export function TopSupplyMovesTable({ data }: { data: ReplenishmentComponentData }) {
  const { top, salesProtected } = computeTopSupplyMoves(data.rows, 10);
  return (
    <div className="overflow-x-auto overflow-y-auto">
      {salesProtected > 0 && (
        <p className="mb-2 text-[11.5px] text-ink-3">
          Potential sales protected by making these moves: <strong className="text-ink-2">{INR(salesProtected)}</strong>.
        </p>
      )}
      <table className="w-full min-w-[720px] text-[12.5px]">
        <thead>
          <tr className="border-b border-line-soft text-left text-[10px] uppercase tracking-wide text-ink-3">
            <th className="px-2 py-1.5">Rank</th>
            <th className="px-2 py-1.5">Style</th>
            <th className="px-2 py-1.5">Store</th>
            <th className="px-2 py-1.5 text-right">SOH</th>
            <th className="px-2 py-1.5 text-right">Cover</th>
            <th className="px-2 py-1.5">Trend</th>
            <th className="px-2 py-1.5 text-right">Recommended</th>
          </tr>
        </thead>
        <tbody>
          {top.map((r, i) => (
            <tr key={`${r.storeId}-${r.styleNo}-${r.color}`} className="border-b border-line-soft last:border-0">
              <td className="px-2 py-1.5 font-mono text-ink-3">{i + 1}</td>
              <td className="px-2 py-1.5">
                <span className="font-mono text-[11.5px]">{r.styleNo}</span> <span className="text-ink-3">{r.color}</span>
              </td>
              <td className="px-2 py-1.5 text-ink-2">{r.storeName}</td>
              <td className="px-2 py-1.5 text-right font-mono">{fmt(r.soh)}</td>
              <td className="px-2 py-1.5 text-right font-mono">{r.coverDays === null ? "—" : `${fmt1(r.coverDays)}d`}</td>
              <td className={`px-2 py-1.5 ${r.trend ? TREND_LABEL[r.trend].className : ""}`}>{r.trend ? TREND_LABEL[r.trend].label : "—"}</td>
              <td className="px-2 py-1.5 text-right font-mono font-semibold">{fmt(r.recommendedQty)}</td>
            </tr>
          ))}
          {top.length === 0 && (
            <tr>
              <td colSpan={7} className="px-2 py-4 text-center text-ink-3">No actionable supply moves right now.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The registry's own most expensive/interactive entry — the FULL
 * allocation-engine output, sorted by priority/score, same as the
 * standalone page's default sort (no page-level filters here; a workspace
 * tile shows the network-wide table, same "no per-tile what-if UI" posture
 * as the other 2 replenishment components).
 *
 * Reuses ReplenishmentGrid.tsx directly — the same client component
 * `/replenishment` itself renders (AG Grid + the row-click detail Dialog) —
 * rather than rebuilding column defs here. AG Grid's `columnDefs` contain
 * functions (cellRenderer/valueFormatter), and functions can't cross the
 * server→client component boundary as props; that column-building logic
 * has to live INSIDE a client component, which ReplenishmentGrid.tsx
 * already is.
 */
export function ReplenishmentRecommendationsTable({ data }: { data: ReplenishmentComponentData }) {
  const PRIORITY_ORDER: Row["priority"][] = ["critical", "high", "medium", "healthy", "exhausted"];
  const rows = [...data.rows].sort(
    (a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority) || b.score - a.score
  );
  return <ReplenishmentGrid rows={rows} />;
}

export const REPLENISHMENT_COMPONENT_RENDERERS: Record<
  string,
  (props: { data: ReplenishmentComponentData }) => JSX.Element
> = {
  replenishment_kpi_grid: ReplenishmentKpiGrid,
  top_supply_moves_table: TopSupplyMovesTable,
  replenishment_recommendations_table: ReplenishmentRecommendationsTable,
};
