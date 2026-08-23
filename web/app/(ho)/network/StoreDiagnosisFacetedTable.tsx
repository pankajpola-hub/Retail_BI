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
import { Pill } from "@/components/ui/Pill";
import type { StoreDiagnosisRow } from "@/lib/network/footfall";

const PAGE_KEY = "network_store_diagnosis";

const INR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/**
 * Phase 3 of the faceted-filtering system (Network) — plain HTML table
 * with a colSpan banner row for group-by, same rationale as
 * AgentSalesFacetedTable.tsx (see that file's header comment). The
 * surrounding section header, "vs" date-range label, and opportunity
 * methodology footnote stay in page.tsx — this component owns only the
 * filter bar and the table itself.
 */
export function StoreDiagnosisFacetedTable({ rows }: { rows: StoreDiagnosisRow[] }) {
  const [state, setState] = useState<FacetFilterState>(emptyFilterState);

  const facets = useMemo<FacetDef<StoreDiagnosisRow>[]>(
    () => [
      { key: "tone", label: "Tone", get: (r) => r.tone },
      { key: "primaryIssue", label: "Primary issue", get: (r) => r.primaryIssue },
    ],
    []
  );

  const advFields = useMemo<AdvField<StoreDiagnosisRow>[]>(
    () => [
      { key: "name", label: "Store", get: (r) => r.name },
      { key: "salesChangePct", label: "Sales Δ%", get: (r) => r.salesChangePct, numeric: true },
      { key: "footfallChangePct", label: "Footfall Δ%", get: (r) => r.footfallChangePct, numeric: true },
      { key: "conversionNow", label: "Conversion now", get: (r) => r.conversionNow, numeric: true },
      { key: "salesPerVisitor", label: "₹/visitor", get: (r) => r.salesPerVisitor, numeric: true },
      { key: "combinedOpportunity", label: "Opportunity", get: (r) => r.combinedOpportunity, numeric: true },
    ],
    []
  );

  const groupByOptions = useMemo(() => [{ key: "tone", label: "Tone" }], []);
  const groupKeyGetters = useMemo<Record<string, (row: StoreDiagnosisRow) => string>>(() => ({ tone: (r) => r.tone }), []);

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
              <th className="px-3 py-2">Store</th>
              <th className="px-3 py-2 text-right">Sales Δ</th>
              <th className="px-3 py-2 text-right">Footfall Δ</th>
              <th className="px-3 py-2 text-right">Conv</th>
              <th className="px-3 py-2 text-right">₹/visitor</th>
              <th className="px-3 py-2">Primary issue</th>
              <th className="px-3 py-2 text-right">Opportunity</th>
              <th className="px-3 py-2">Recommended</th>
            </tr>
          </thead>
          <tbody>
            {gridRows.map((s) =>
              "__groupHeader" in s ? (
                <tr key={s.id} className="border-b border-line-soft bg-surface-2">
                  <td colSpan={8} className="px-3 py-1.5 text-[12px] font-semibold text-ink-2" style={{ paddingLeft: 12 + s.level * 16 }}>
                    {s.label} <span className="font-mono font-normal text-ink-3">({s.count})</span>
                  </td>
                </tr>
              ) : (
                <tr key={s.storeId} className="border-b border-line-soft last:border-0">
                  <td className="px-3 py-2">{s.name}</td>
                  <td
                    className={`px-3 py-2 text-right font-mono ${
                      s.salesChangePct === null ? "text-ink-3" : s.salesChangePct >= 0 ? "text-good" : "text-crit"
                    }`}
                  >
                    {s.salesChangePct !== null ? `${s.salesChangePct >= 0 ? "+" : ""}${s.salesChangePct.toFixed(1)}%` : "—"}
                  </td>
                  <td className={`px-3 py-2 text-right font-mono ${s.footfallChangePct >= 0 ? "text-good" : "text-crit"}`}>
                    {s.footfallChangePct >= 0 ? "+" : ""}
                    {s.footfallChangePct.toFixed(1)}%
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {s.conversionNow.toFixed(1)}%
                    <span className={`ml-1 text-[11px] ${s.conversionChangePts >= 0 ? "text-good" : "text-crit"}`}>
                      {s.conversionChangePts >= 0 ? "+" : ""}
                      {s.conversionChangePts.toFixed(1)}pp
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{s.salesPerVisitor !== null ? INR(s.salesPerVisitor) : "—"}</td>
                  <td className="px-3 py-2">
                    <Pill tone={s.tone}>{s.headline}</Pill>
                    <div className="mt-0.5 text-[11.5px] text-ink-3">{s.primaryIssue}</div>
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{s.combinedOpportunity > 0 ? INR(s.combinedOpportunity) : "—"}</td>
                  <td className="px-3 py-2 text-ink-2">{s.recommendation}</td>
                </tr>
              )
            )}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-4 text-center text-sm text-ink-3">
                  No stores match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
