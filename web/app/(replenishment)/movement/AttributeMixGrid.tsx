"use client";

import { useMemo } from "react";
import type { ColDef, ICellRendererParams, ValueGetterParams } from "ag-grid-community";
import { DataGrid } from "@/components/ui/DataGrid";
import { MIX_STATUS_META, type MixStatus } from "@/lib/replenishment/mixShared";
import type { AttributeMixRow, AttributeKey } from "@/lib/replenishment/mixAttributes";
import { ATTRIBUTE_COLUMN_LABELS } from "@/lib/replenishment/mixAttributes";

const fmt = (n: number) => Math.round(n).toLocaleString("en-IN");
const pct = (n: number) => `${n.toFixed(1)}%`;
const pts = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1)}pp`;

/**
 * Sibling to ../sale-stock-mix/SaleStockMixGrid.tsx, for the attribute-wise
 * "View by" combo (drag attribute chips into the bar in
 * SaleStockMixFacetedContent.tsx — Color / Size / Size Group / Gender /
 * Season+Year / MRP Range, any combination). One leading grid column per
 * attribute in the combo (rows here are grouped by ALL of them together —
 * a combo of [Gender, Color] means one row per gender+color pair, not two
 * separate breakdowns), independently sortable rather than one combined
 * label string.
 */
export function AttributeMixGrid({ rows, attributes }: { rows: AttributeMixRow[]; attributes: AttributeKey[] }) {
  const columnDefs = useMemo<ColDef<AttributeMixRow>[]>(() => {
    const attributeCols: ColDef<AttributeMixRow>[] = attributes.map((attr, i) => ({
      headerName: ATTRIBUTE_COLUMN_LABELS[attr],
      flex: 1,
      sortable: true,
      valueGetter: (p: ValueGetterParams<AttributeMixRow>) => p.data?.values[i] ?? "",
      cellRenderer:
        i === 0
          ? (p: ICellRendererParams<AttributeMixRow>) => (
              <span>
                {p.data!.values[0]}
                {p.data!.negativeStock && (
                  <span className="ml-1 text-crit" title="Negative stock in source data">⚠</span>
                )}
              </span>
            )
          : undefined,
    }));

    return [
      ...attributeCols,
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
        // Status merged into Action (2026-08-25) — same treatment as
        // ../sale-stock-mix/SaleStockMixGrid.tsx.
        headerName: "Action",
        flex: 2,
        cellClass: "text-ink-2 py-1",
        autoHeight: true,
        cellRenderer: (p: ICellRendererParams<AttributeMixRow>) => {
          const r = p.data!;
          const meta = MIX_STATUS_META[r.status as MixStatus];
          const isAllocationCandidate = r.status === "high_priority" || r.status === "opportunity";
          const warehouseBlocked = isAllocationCandidate && r.warehouseAvailable === 0;
          return (
            <div className="py-1 leading-tight">
              <div className={warehouseBlocked ? "text-warn font-semibold" : meta.className}>
                {meta.dot} {warehouseBlocked ? "Demand Opportunity — Warehouse Stock Unavailable" : meta.action}
              </div>
              <div className="text-[11px] font-normal text-ink-3">{meta.demandLabel.toLowerCase()}</div>
            </div>
          );
        },
      },
    ];
  }, [attributes]);

  const comboLabel = attributes.map((a) => ATTRIBUTE_COLUMN_LABELS[a]).join(" + ");

  return (
    <DataGrid<AttributeMixRow>
      rowData={rows}
      columnDefs={columnDefs}
      heightPx={Math.min(640, Math.max(160, 46 + rows.length * 40))}
      getRowId={(p) => p.data.values.join("|")}
      overlayNoRowsTemplate={`No ${comboLabel.toLowerCase()} groups match this scope.`}
    />
  );
}
