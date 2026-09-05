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

/**
 * freshQty/eossQty are OPTIONAL (2026-09-05). /sales computes them per line
 * (computeAgentRowsFromLines, 0058's discount_ratio rule) and gets three unit
 * columns; /network still reads sales.vw_ebo_agent_daily, a pre-aggregated
 * rollup with no discount on it at all, and gets the single Units column it
 * always had. Rendering "—" in two extra columns there would advertise a
 * breakdown that view cannot supply, so the columns are only added when the
 * rows actually carry the split — see `hasSplit` below.
 */
type AgentRow = ReturnType<typeof computeAgentRows>[number] & { freshQty?: number; eossQty?: number };

const INR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const NUM = (n: number) => n.toLocaleString("en-IN");

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

  // Every row carries the split or none do — the two callers each pass a
  // whole row-set from one source. Checked with .some() rather than assumed
  // from a prop so a caller cannot get the two out of step.
  const hasSplit = useMemo(() => rows.some((r) => r.freshQty !== undefined), [rows]);
  const colCount = hasSplit ? 8 : 6;

  const facets = useMemo<FacetDef<AgentRow>[]>(
    () => [{ key: "store", label: "Store", get: (r) => storeNames[r.storeId] ?? r.storeId }],
    [storeNames]
  );

  const advFields = useMemo<AdvField<AgentRow>[]>(
    () => [
      { key: "agent", label: "Agent", get: (r) => r.agent },
      { key: "store", label: "Store", get: (r) => storeNames[r.storeId] ?? r.storeId },
      { key: "bills", label: "Bills", get: (r) => r.bills, numeric: true },
      ...(hasSplit
        ? ([
            { key: "freshQty", label: "Fresh qty", get: (r: AgentRow) => r.freshQty ?? 0, numeric: true },
            { key: "eossQty", label: "EOSS qty", get: (r: AgentRow) => r.eossQty ?? 0, numeric: true },
          ] as AdvField<AgentRow>[])
        : []),
      { key: "qty", label: hasSplit ? "Total qty" : "Units", get: (r) => r.qty, numeric: true },
      { key: "net", label: "Net", get: (r) => r.net, numeric: true },
      { key: "atv", label: "ATV", get: (r) => (r.bills > 0 ? r.net / r.bills : 0), numeric: true },
    ],
    [storeNames, hasSplit]
  );

  const groupByOptions = useMemo(() => [{ key: "store", label: "Store" }], []);
  const groupKeyGetters = useMemo<Record<string, (row: AgentRow) => string>>(
    () => ({ store: (r) => storeNames[r.storeId] ?? r.storeId }),
    [storeNames]
  );

  const filtered = useMemo(() => applyFacetFilter(rows, facets, advFields, state), [rows, facets, advFields, state]);
  const gridRows = useMemo(() => buildGroupedRows(filtered, state.groupBy, groupKeyGetters), [filtered, state.groupBy, groupKeyGetters]);

  /**
   * <tfoot> totals over `filtered` (the group-by banners in `gridRows` are
   * presentation only and carry no numbers of their own).
   *
   * Bills / Units / Net sum. ATV is recomputed as Σnet/Σbills — the same
   * expression the per-row cell uses below (`row.bills > 0 ? row.net /
   * row.bills : "—"`), applied to the totals — NOT an average of the per-agent
   * ATVs, which would weight a 2-bill agent the same as a 200-bill one.
   */
  const totals = useMemo(() => {
    let bills = 0;
    let qty = 0;
    let freshQty = 0;
    let eossQty = 0;
    let net = 0;
    for (const r of filtered) {
      bills += r.bills;
      qty += r.qty;
      freshQty += r.freshQty ?? 0;
      eossQty += r.eossQty ?? 0;
      net += r.net;
    }
    return { bills, qty, freshQty, eossQty, net, atv: bills > 0 ? net / bills : null };
  }, [filtered]);

  return (
    <>
      {/* This table attributes SALE bills to whoever rang them up — a return
          isn't necessarily processed by the same agent as the original sale,
          so netting it off here would misattribute someone else's return
          against this agent's number. sales.vw_ebo_agent_daily (the view
          this reads) is built WHERE bill_type = 'SALE' on purpose. That's
          why this "Net" is smaller-scoped than the page's own "Net Sales"
          KPI card, which nets returns off the whole network — both numbers
          are correct, they just answer different questions. */}
      <p className="mb-2 text-[11.5px] text-ink-3">
        Sale bills only (not netted against returns) — differs from the page&apos;s Net Sales KPI, which nets returns off the whole network.
      </p>
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
              {hasSplit && (
                <>
                  <th className="px-3 py-2 text-right" title="Units on lines discounted less than 49.5% of gross — the same Fresh rule the Targets tracker uses.">
                    Fresh qty
                  </th>
                  <th className="px-3 py-2 text-right" title="Units on lines discounted 49.5% of gross or more — what Targets calls Discounted.">
                    EOSS qty
                  </th>
                </>
              )}
              <th className="px-3 py-2 text-right">{hasSplit ? "Total qty" : "Units"}</th>
              <th className="px-3 py-2 text-right" title="Sale bills only, not netted against returns — see the note above.">
                Net (sale bills)
              </th>
              <th className="px-3 py-2 text-right">ATV</th>
            </tr>
          </thead>
          <tbody>
            {gridRows.map((row) =>
              "__groupHeader" in row ? (
                <tr key={row.id} className="border-b border-line-soft bg-surface-2">
                  <td colSpan={colCount} className="px-3 py-1.5 text-[12px] font-semibold text-ink-2" style={{ paddingLeft: 12 + row.level * 16 }}>
                    {row.label} <span className="font-mono font-normal text-ink-3">({row.count})</span>
                  </td>
                </tr>
              ) : (
                <tr key={`${row.storeId}-${row.agent}`} className="border-b border-line-soft last:border-0">
                  <td className="px-3 py-2">{row.agent}</td>
                  <td className="px-3 py-2 text-ink-3">{storeNames[row.storeId] ?? row.storeId}</td>
                  <td className="px-3 py-2 text-right font-mono">{row.bills}</td>
                  {hasSplit && (
                    <>
                      <td className="px-3 py-2 text-right font-mono">{NUM(row.freshQty ?? 0)}</td>
                      <td className="px-3 py-2 text-right font-mono">{NUM(row.eossQty ?? 0)}</td>
                    </>
                  )}
                  <td className="px-3 py-2 text-right font-mono">{NUM(row.qty)}</td>
                  <td className="px-3 py-2 text-right font-mono">{INR(row.net)}</td>
                  <td className="px-3 py-2 text-right font-mono">{row.bills > 0 ? INR(row.net / row.bills) : "—"}</td>
                </tr>
              )
            )}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={colCount} className="px-3 py-4 text-center text-sm text-ink-3">
                  No agent data matches these filters.
                </td>
              </tr>
            )}
          </tbody>
          {filtered.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-line bg-surface-2 font-bold">
                <td className="px-3 py-2">Total</td>
                <td className="px-3 py-2 text-ink-3">{filtered.length} agents</td>
                <td className="px-3 py-2 text-right font-mono">{totals.bills}</td>
                {hasSplit && (
                  <>
                    <td className="px-3 py-2 text-right font-mono">{NUM(totals.freshQty)}</td>
                    <td className="px-3 py-2 text-right font-mono">{NUM(totals.eossQty)}</td>
                  </>
                )}
                <td className="px-3 py-2 text-right font-mono">{NUM(totals.qty)}</td>
                <td className="px-3 py-2 text-right font-mono">{INR(totals.net)}</td>
                <td className="px-3 py-2 text-right font-mono">{totals.atv !== null ? INR(totals.atv) : "—"}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </>
  );
}
