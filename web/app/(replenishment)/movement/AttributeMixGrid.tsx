"use client";

import { useMemo } from "react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { DataGrid } from "@/components/ui/DataGrid";
import { MIX_STATUS_META, type MixStatus } from "@/lib/replenishment/mixShared";
import type { AttributeMixRow, AttributeKey } from "@/lib/replenishment/mixAttributes";
import { ATTRIBUTE_COLUMN_LABELS } from "@/lib/replenishment/mixAttributes";

const fmt = (n: number) => Math.round(n).toLocaleString("en-IN");
const pct = (n: number) => `${n.toFixed(1)}%`;
const pts = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1)}pp`;

/**
 * Sibling to ../sale-stock-mix/SaleStockMixGrid.tsx, for the attribute-wise
 * "View by" pills (Color / Size / Gender / Season+Year / MRP Range) — a
 * simpler grid than the default Style+Color one: rows here are already one
 * per attribute value (a handful to a few dozen), so there's no group-by
 * banner-row plumbing to carry over, just a plain sortable table. First
 * column header changes per attribute (`attribute` prop) so "Color" reads
 * as "Color", "Season + Year" reads as "Season", etc.
 */
export function AttributeMixGrid({ rows, attribute }: { rows: AttributeMixRow[]; attribute: AttributeKey }) {
  const columnDefs = useMemo<ColDef<AttributeMixRow>[]>(
    () => [
      {
        field: "label",
        headerName: ATTRIBUTE_COLUMN_LABELS[attribute],
        flex: 1.4,
        sortable: true,
        cellRenderer: (p: ICellRendererParams<AttributeMixRow>) => {
          const r = p.data!;
          return (
            <span>
              {r.label}
              {r.negativeStock && (
                <span className="ml-1 text-crit" title="Negative stock in source data">⚠</span>
              )}
            </span>
          );
        },
      },
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
        cellRenderer: (p: ICellRendererParams<AttributeMixRow>) => {
          const meta = MIX_STATUS_META[p.data!.status as MixStatus];
          return <span className={meta.className}>{meta.dot} {meta.demandLabel}</span>;
        },
      },
      {
        headerName: "Action",
        flex: 1.6,
        cellClass: "text-ink-2",
        cellRenderer: (p: ICellRendererParams<AttributeMixRow>) => {
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
    [attribute]
  );

  return (
    <DataGrid<AttributeMixRow>
      rowData={rows}
      columnDefs={columnDefs}
      heightPx={Math.min(640, Math.max(160, 46 + rows.length * 40))}
      getRowId={(p) => p.data.label}
      overlayNoRowsTemplate={`No ${ATTRIBUTE_COLUMN_LABELS[attribute].toLowerCase()} groups match this scope.`}
    />
  );
}
