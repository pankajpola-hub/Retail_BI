"use client";

import { useMemo, useState } from "react";
import {
  FacetFilterBar,
  applyFacetFilter,
  buildGroupedRows,
  emptyFilterState,
  type FacetDef,
  type AdvField,
  type FacetFilterState,
} from "@/components/ui/FacetFilterBar";
import type { computeAgentRows } from "@/lib/sales/aggregate";

const PAGE_KEY = "network_agent_sales";

type AgentRow = ReturnType<typeof computeAgentRows>[number];

const INR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/**
 * Phase 3 of the faceted-filtering system (Network) — same
 * FacetFilterBar/applyFacetFilter/buildGroupedRows engine as the Movement
 * pages, but this table stays plain HTML (see ReplenishmentGrid.tsx's
 * colSpan technique for the AG Grid equivalent) since computeAgentRows()
 * hard-caps at 12 rows — no AG Grid needed at this scale. Group-by banner
 * rows use the same native <td colSpan> a plain <table> already supports,
 * so no imperative sort-clearing workaround is needed either (this table
 * has no default sort to begin with).
 */
export function AgentSalesFacetedTable({ rows, storeNames }: { rows: AgentRow[]; storeNames: Record<string, string> }) {
  const [state, setState] = useState<FacetFilterState>(emptyFilterState);

  const facets = useMemo<FacetDef<AgentRow>[]>(
    () => [{ key: "store", label: "Store", get: (r) => storeNames[r.storeId] ?? r.storeId }],
    [storeNames]
  );

  const advFields = useMemo<AdvField<AgentRow>[]>(
    () => [
      { key: "agent", label: "Agent", get: (r) => r.agent },
      { key: "store", label: "Store", get: (r) => storeNames[r.storeId] ?? r.storeId },
      { key: "bills", label: "Bills", get: (r) => r.bills, numeric: true },
      { key: "qty", label: "Units", get: (r) => r.qty, numeric: true },
      { key: "net", label: "Net", get: (r) => r.net, numeric: true },
      { key: "atv", label: "ATV", get: (r) => (r.bills > 0 ? r.net / r.bills : 0), numeric: true },
    ],
    [storeNames]
  );

  const groupByOptions = useMemo(() => [{ key: "store", label: "Store" }], []);
  const groupKeyGetters = useMemo<Record<string, (row: AgentRow) => string>>(
    () => ({ store: (r) => storeNames[r.storeId] ?? r.storeId }),
    [storeNames]
  );

  const filtered = useMemo(() => applyFacetFilter(rows, facets, advFields, state), [rows, facets, advFields, state]);
  const gridRows = useMemo(() => buildGroupedRows(filtered, state.groupBy, groupKeyGetters), [filtered, state.groupBy, groupKeyGetters]);

  return (
    <>
      <FacetFilterBar
        pageKey={PAGE_KEY}
        rows={rows}
        facets={facets}
        advFields={advFields}
        groupByOptions={groupByOptions}
        state={state}
        onChange={setState}
      />
      <div className="mt-2 overflow-x-auto border border-line-soft">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line-soft bg-surface-2 text-left text-[10px] uppercase tracking-wide text-ink-3">
              <th className="px-3 py-2">Agent</th>
              <th className="px-3 py-2">Store</th>
              <th className="px-3 py-2 text-right">Bills</th>
              <th className="px-3 py-2 text-right">Units</th>
              <th className="px-3 py-2 text-right">Net</th>
              <th className="px-3 py-2 text-right">ATV</th>
            </tr>
          </thead>
          <tbody>
            {gridRows.map((row) =>
              "__groupHeader" in row ? (
                <tr key={row.id} className="border-b border-line-soft bg-surface-2">
                  <td colSpan={6} className="px-3 py-1.5 text-[12px] font-semibold text-ink-2" style={{ paddingLeft: 12 + row.level * 16 }}>
                    {row.label} <span className="font-mono font-normal text-ink-3">({row.count})</span>
                  </td>
                </tr>
              ) : (
                <tr key={`${row.storeId}-${row.agent}`} className="border-b border-line-soft last:border-0">
                  <td className="px-3 py-2">{row.agent}</td>
                  <td className="px-3 py-2 text-ink-3">{storeNames[row.storeId] ?? row.storeId}</td>
                  <td className="px-3 py-2 text-right font-mono">{row.bills}</td>
                  <td className="px-3 py-2 text-right font-mono">{row.qty}</td>
                  <td className="px-3 py-2 text-right font-mono">{INR(row.net)}</td>
                  <td className="px-3 py-2 text-right font-mono">{row.bills > 0 ? INR(row.net / row.bills) : "—"}</td>
                </tr>
              )
            )}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-sm text-ink-3">
                  No agent data matches these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
