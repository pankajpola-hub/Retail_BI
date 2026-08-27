"use client";

import { useMemo } from "react";
import type { ColDef } from "ag-grid-community";
import { DataGrid } from "@/components/ui/DataGrid";
import type { CapacityGridRow } from "@/lib/stockDetails/aggregate";

export type { CapacityGridRow };

const fmt = (n: number) => Math.round(n).toLocaleString("en-IN");

// Buffer% is the one non-additive numeric column here: `bufferPct` is the
// buffered capacity expressed as a PERCENT OF BASE (aggregate.ts:176 —
// `bufferedCapacity = baseCapacity * bufferPct / 100`, and
// freshCapacity + eossCapacity === bufferedCapacity). Averaging or summing
// per-row percentages would be meaningless, so the total row recomputes it
// from the summed numerator and denominator:
//   Σ(freshTarget + eossTarget) / Σ(baseCapacity) × 100
// Zero base capacity → null, rendered as "—" rather than NaN/Infinity.
function totalRow(rows: CapacityGridRow[]): CapacityGridRow[] {
  if (rows.length === 0) return [];
  const sum = (pick: (r: CapacityGridRow) => number) => rows.reduce((s, r) => s + pick(r), 0);
  const baseCapacity = sum((r) => r.baseCapacity);
  const freshTarget = sum((r) => r.freshTarget);
  const eossTarget = sum((r) => r.eossTarget);
  const bufferPct = baseCapacity > 0 ? Math.round(((freshTarget + eossTarget) / baseCapacity) * 1000) / 10 : null;
  return [
    {
      storeId: "__total__",
      storeName: "Total",
      segment: `${rows.length} row${rows.length === 1 ? "" : "s"}`,
      baseCapacity,
      // `bufferPct` is typed number on CapacityGridRow; the pinned row is the
      // only place it can legitimately be absent (no base capacity anywhere).
      bufferPct: bufferPct as unknown as number,
      freshTarget,
      freshActual: sum((r) => r.freshActual),
      // Status is a per-block verdict ("Over plan" / "Under plan"); there is no
      // meaningful roll-up of it, so the total row leaves both status cells blank.
      freshStatusLabel: "—",
      freshStatusClass: "",
      eossTarget,
      eossActual: sum((r) => r.eossActual),
      eossStatusLabel: "—",
      eossStatusClass: "",
    },
  ];
}

/**
 * 2026-08-20 — replaces what used to be ONE `<table>` PER STORE
 * (`StockVsCapacityTable`, one call per entry in `storesInView`). That's a
 * different scale problem than the Replenishment/Store-League conversions
 * solved (those were one wide table with many rows; this was many small
 * tables stacked vertically) — but it's the exact one Objective.md's Scale
 * target section names explicitly: "Several existing pages render one
 * block/table per store... a wall of cards at 100 stores." A single grid
 * with a sortable/filterable Store column fixes that directly, and gives
 * every segment across every store one scannable, sortable table instead of
 * requiring a store-by-store scroll to compare status.
 */
export function StockVsCapacityGrid({ rows }: { rows: CapacityGridRow[] }) {
  const pinnedBottomRowData = useMemo(() => totalRow(rows), [rows]);
  const columnDefs = useMemo<ColDef<CapacityGridRow>[]>(
    () => [
      { field: "storeName", headerName: "Store", flex: 1.2, sortable: true, filter: true, cellClass: "font-medium text-ink-2" },
      { field: "segment", headerName: "Segment", flex: 1, sortable: true, filter: true },
      { field: "baseCapacity", headerName: "Base cap.", flex: 0.9, sortable: true, cellClass: "text-right font-mono text-ink-2", headerClass: "text-right", valueFormatter: (p) => fmt(p.value) },
      { field: "bufferPct", headerName: "Buffer", flex: 0.7, sortable: true, cellClass: "text-right font-mono text-ink-2", headerClass: "text-right", valueFormatter: (p) => (p.value == null ? "—" : `${p.value}%`) },
      { field: "freshTarget", headerName: "Fresh planned", flex: 1, sortable: true, cellClass: "text-right font-mono text-ink-2", headerClass: "text-right", valueFormatter: (p) => fmt(p.value) },
      { field: "freshActual", headerName: "Fresh current", flex: 1, sortable: true, cellClass: "text-right font-mono text-ink-2", headerClass: "text-right", valueFormatter: (p) => fmt(p.value) },
      {
        field: "freshStatusLabel",
        headerName: "Fresh status",
        flex: 1.2,
        sortable: true,
        cellClass: (p) => `text-right font-semibold ${p.data?.freshStatusClass ?? ""}`,
        headerClass: "text-right",
      },
      { field: "eossTarget", headerName: "EOSS planned", flex: 1, sortable: true, cellClass: "text-right font-mono text-ink-2", headerClass: "text-right", valueFormatter: (p) => fmt(p.value) },
      { field: "eossActual", headerName: "EOSS current", flex: 1, sortable: true, cellClass: "text-right font-mono text-ink-2", headerClass: "text-right", valueFormatter: (p) => fmt(p.value) },
      {
        field: "eossStatusLabel",
        headerName: "EOSS status",
        flex: 1.2,
        sortable: true,
        cellClass: (p) => `text-right font-semibold ${p.data?.eossStatusClass ?? ""}`,
        headerClass: "text-right",
      },
    ],
    []
  );

  return (
    <DataGrid<CapacityGridRow>
      rowData={rows}
      columnDefs={columnDefs}
      pinnedBottomRowData={pinnedBottomRowData}
      // +40 for the pinned total row so it never eats a data row's height.
      heightPx={Math.min(600, Math.max(160, 46 + rows.length * 40 + (pinnedBottomRowData.length > 0 ? 40 : 0)))}
      // Same summary-row treatment the Sales page's Network total uses
      // (PeriodSalesFacetedTable.tsx:231) — inline, because AG Grid's own
      // .ag-row background/font rules otherwise win the cascade.
      getRowStyle={(p) => (p.node.rowPinned === "bottom" ? { background: "var(--surface-2)", fontWeight: 600 } : undefined)}
      overlayNoRowsTemplate="No capacity plan set for the selected store(s)."
    />
  );
}
