"use client";

import { useMemo } from "react";
import type { ColDef } from "ag-grid-community";
import { DataGrid } from "@/components/ui/DataGrid";
import type { CapacityGridRow } from "@/lib/stockDetails/aggregate";

export type { CapacityGridRow };

const fmt = (n: number) => Math.round(n).toLocaleString("en-IN");

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
  const columnDefs = useMemo<ColDef<CapacityGridRow>[]>(
    () => [
      { field: "storeName", headerName: "Store", flex: 1.2, sortable: true, filter: true, cellClass: "font-medium text-ink-2" },
      { field: "segment", headerName: "Segment", flex: 1, sortable: true, filter: true },
      { field: "baseCapacity", headerName: "Base cap.", flex: 0.9, sortable: true, cellClass: "text-right font-mono text-ink-2", headerClass: "text-right", valueFormatter: (p) => fmt(p.value) },
      { field: "bufferPct", headerName: "Buffer", flex: 0.7, sortable: true, cellClass: "text-right font-mono text-ink-2", headerClass: "text-right", valueFormatter: (p) => `${p.value}%` },
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
      heightPx={Math.min(560, Math.max(160, 46 + rows.length * 40))}
      overlayNoRowsTemplate="No capacity plan set for the selected store(s)."
    />
  );
}
