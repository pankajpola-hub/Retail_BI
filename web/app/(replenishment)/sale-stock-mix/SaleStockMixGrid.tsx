"use client";

import { useMemo } from "react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { DataGrid } from "@/components/ui/DataGrid";
import type { MixStatus, MixRow } from "@/lib/replenishment/mix";

// lib/replenishment/mix.ts is "server-only" — MIX_STATUS_META can't be
// imported as a value into this client component (same lesson as
// ReplenishmentGrid.tsx's fmt/fmt1 and the earlier Workspace column-def
// bug: a runtime import pulls in the whole module, including the
// server-only guard). Duplicated here verbatim; only the type import above
// is safe (erased at compile time).
const MIX_STATUS_META: Record<MixStatus, { dot: string; label: string; demandLabel: string; action: string; className: string }> = {
  high_priority: { dot: "🔥", label: "High Priority", demandLabel: "High Demand / Low Stock", action: "Prioritize Allocation", className: "text-crit font-semibold" },
  opportunity: { dot: "🟢", label: "Allocation Opportunity", demandLabel: "Demand Higher Than Stock", action: "Consider Allocation", className: "text-good font-semibold" },
  balanced: { dot: "✅", label: "Balanced", demandLabel: "Balanced", action: "Maintain", className: "text-ink-2" },
  stock_heavy: { dot: "🟠", label: "Stock Heavy", demandLabel: "Stock Higher Than Demand", action: "Reduce / Hold Allocation", className: "text-warn font-semibold" },
  overstocked: { dot: "🔴", label: "Overstocked", demandLabel: "Low Demand / High Stock", action: "Do Not Allocate", className: "text-crit font-semibold" },
};

const fmt = (n: number) => Math.round(n).toLocaleString("en-IN");
const pct = (n: number) => `${n.toFixed(1)}%`;
const pts = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1)}pp`;

/**
 * 2026-08-20 — same AG Grid conversion as the Replenishment/Store League/
 * Stock capacity tables: this page's main table is server-paginated over
 * potentially hundreds of style-colors, the exact scale problem AG Grid
 * solves. Server-side filter/pagination logic in page.tsx is unchanged —
 * this renders whatever page of rows the server already sliced.
 */
export function SaleStockMixGrid({ rows }: { rows: MixRow[] }) {
  const columnDefs = useMemo<ColDef<MixRow>[]>(
    () => [
      {
        field: "styleNo",
        headerName: "Style No.",
        flex: 1,
        sortable: true,
        cellClass: "font-mono text-[11.5px]",
        valueFormatter: (p) => p.value,
        cellRenderer: (p: ICellRendererParams<MixRow>) => (
          <span>
            {p.data!.styleNo}
            {p.data!.negativeStock && (
              <span className="ml-1 text-crit" title="Negative stock in source data">⚠</span>
            )}
          </span>
        ),
      },
      { field: "color", headerName: "Color", flex: 0.8, sortable: true, cellClass: "text-ink-2" },
      { field: "sales", headerName: "Sales", flex: 0.8, sortable: true, cellClass: "text-right font-mono", headerClass: "text-right", valueFormatter: (p) => fmt(p.value) },
      { field: "saleMixPct", headerName: "Sale Mix", flex: 0.8, sortable: true, cellClass: "text-right font-mono", headerClass: "text-right", valueFormatter: (p) => pct(p.value) },
      { field: "soh", headerName: "Store SOH", flex: 0.8, sortable: true, cellClass: "text-right font-mono", headerClass: "text-right", valueFormatter: (p) => fmt(p.value) },
      { field: "warehouseAvailable", headerName: "WH SOH", flex: 0.8, sortable: true, cellClass: "text-right font-mono", headerClass: "text-right", valueFormatter: (p) => fmt(p.value) },
      { field: "stockMixPct", headerName: "Stock Mix", flex: 0.8, sortable: true, cellClass: "text-right font-mono", headerClass: "text-right", valueFormatter: (p) => pct(p.value) },
      {
        field: "mixGapPts",
        headerName: "Mix Gap",
        flex: 0.8,
        sortable: true,
        cellClass: (p) => `text-right font-mono font-semibold ${p.value > 0 ? "text-good" : p.value < 0 ? "text-crit" : "text-ink-3"}`,
        headerClass: "text-right",
        valueFormatter: (p) => pts(p.value),
      },
      {
        field: "status",
        headerName: "Status",
        flex: 1.2,
        sortable: true,
        cellRenderer: (p: ICellRendererParams<MixRow>) => {
          const meta = MIX_STATUS_META[p.data!.status];
          return <span className={meta.className}>{meta.dot} {meta.demandLabel}</span>;
        },
      },
      {
        headerName: "Action",
        flex: 1.6,
        cellClass: "text-ink-2",
        cellRenderer: (p: ICellRendererParams<MixRow>) => {
          const r = p.data!;
          const meta = MIX_STATUS_META[r.status];
          const isAllocationCandidate = r.status === "high_priority" || r.status === "opportunity";
          const warehouseBlocked = isAllocationCandidate && r.warehouseAvailable === 0;
          return warehouseBlocked ? (
            <span className="text-warn">Demand Opportunity — Warehouse Stock Unavailable</span>
          ) : (
            <span>{meta.action}</span>
          );
        },
      },
    ],
    []
  );

  return (
    <DataGrid<MixRow>
      rowData={rows}
      columnDefs={columnDefs}
      heightPx={Math.min(640, Math.max(160, 46 + rows.length * 40))}
      overlayNoRowsTemplate="No style-colors match these filters."
    />
  );
}
