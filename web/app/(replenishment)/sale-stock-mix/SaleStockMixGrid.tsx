"use client";

import { useMemo } from "react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { DataGrid } from "@/components/ui/DataGrid";
import type { MixRow } from "@/lib/replenishment/mix";
import { MIX_STATUS_META } from "@/lib/replenishment/mixShared";
import type { GroupHeaderRow } from "@/components/ui/FacetFilterBar";

// Group-by (Phase 1 of the faceted-filtering system, ported from
// ReplenishmentGrid.tsx — see that file's header for why this is a colSpan
// banner row, not AG Grid's isFullWidthRow). Unlike Replenishment's grid,
// no column here has a declarative default `sort`, so there's no
// equivalent stale-sort-model issue to clear imperatively — the row order
// buildGroupedRows produces is respected as-is. Optional and additive: no
// other caller of this component exists yet outside this one tab.
export type GridRow = MixRow | GroupHeaderRow;

function isGroupHeader(row: GridRow | undefined): row is GroupHeaderRow {
  return !!row && "__groupHeader" in row && row.__groupHeader === true;
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-IN");
const pct = (n: number) => `${n.toFixed(1)}%`;
const pts = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1)}pp`;

/**
 * 2026-08-20 — same AG Grid conversion as the Replenishment/Store League/
 * Stock capacity tables: this page's main table can span hundreds of
 * style-colors, the exact scale problem AG Grid solves.
 *
 * Display filtering/search/pagination is NOT server-side anymore for the
 * Movement tab that uses this (see SaleStockMixFacetedContent.tsx, Phase 1
 * of the faceted-filtering system) — this grid just renders whatever full
 * or grouped row array its caller hands it, AG Grid's own virtualized
 * scrolling handling row count instead of a manual pager. `salesPeriodDays`
 * is still a real server-side input (it changes which rows get computed at
 * all, not just which are displayed), so that one stays a server
 * round-trip in page.tsx.
 */
export function SaleStockMixGrid({ rows }: { rows: GridRow[] }) {
  const columnDefs = useMemo<ColDef<MixRow>[]>(
    () => [
      {
        field: "styleNo",
        headerName: "Style No.",
        flex: 1,
        sortable: true,
        cellClass: "font-mono text-[11.5px]",
        // colSpan makes this cell cover every column for a group-header
        // row (see the file header) — same technique as
        // ReplenishmentGrid.tsx. 9 = total column count below (Status was
        // merged into Action on 2026-08-25 — one less column).
        colSpan: (p: { data?: GridRow }) => (isGroupHeader(p.data) ? 9 : 1),
        valueFormatter: (p) => p.value,
        cellRenderer: (p: ICellRendererParams<GridRow>) => {
          if (isGroupHeader(p.data)) {
            const g = p.data;
            return (
              <div className="flex h-full items-center gap-2 bg-surface-2 px-1 text-[12px] font-semibold text-ink-2" style={{ paddingLeft: g.level * 16 }}>
                <span>{g.label}</span>
                <span className="font-mono font-normal text-ink-3">({g.count})</span>
              </div>
            );
          }
          const r = p.data as MixRow;
          return (
            <span>
              {r.styleNo}
              {r.negativeStock && (
                <span className="ml-1 text-crit" title="Negative stock in source data">⚠</span>
              )}
            </span>
          );
        },
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
        // Status merged into Action (2026-08-25) — one column instead of
        // two: what to do reads first, why (the status demand label) reads
        // underneath as a smaller subtitle, rather than making the reader
        // cross-reference a separate Status cell to understand the Action
        // cell next to it.
        headerName: "Action",
        flex: 2,
        cellClass: "text-ink-2 py-1",
        autoHeight: true,
        cellRenderer: (p: ICellRendererParams<MixRow>) => {
          const r = p.data!;
          const meta = MIX_STATUS_META[r.status];
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
    ],
    []
  );

  return (
    <DataGrid<GridRow>
      rowData={rows}
      columnDefs={columnDefs as unknown as ColDef<GridRow>[]}
      heightPx={Math.min(640, Math.max(160, 46 + rows.length * 40))}
      getRowId={(p) => (isGroupHeader(p.data) ? p.data.id : `${p.data.styleNo}|${p.data.color}`)}
      overlayNoRowsTemplate="No style-colors match these filters."
    />
  );
}
