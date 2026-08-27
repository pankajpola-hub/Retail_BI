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

// Pinned grand-total row styling. Same treatment the Sales page's own
// total rows use (surface-2 tint + weight), plus a hard top border so the
// footer reads as a rule under the data rather than one more row.
const TOTAL_ROW_STYLE = {
  background: "var(--surface-2)",
  fontWeight: 600,
  borderTop: "2px solid var(--line)",
} as const;

/**
 * Grand total over the CURRENTLY SUPPLIED rows (the caller hands this grid
 * the already-facet-filtered array, so the footer follows the filters).
 *
 * Arithmetic — matched against mixAttributes.ts:128–130, which is where the
 * per-row values come from:
 *   saleMixPct  = sales / totalSales * 100        (totalSales is the same
 *   stockMixPct = max(0, soh) / totalStock * 100   scope-wide denominator
 *                                                  for every row)
 * Because every row divides by the SAME denominator, summing the per-row
 * percentages is itself the recompute-from-summed-numerator rule:
 *   Σ(salesᵢ / T · 100) = (Σsalesᵢ) / T · 100
 * It lands on exactly 100% with no filter active, and correctly reads LESS
 * than 100% when a facet filter hides part of the scope — which is the
 * honest number ("these rows are 38.4% of the scope's sales"), and strictly
 * more informative than hard-coding "100%".
 *
 * Mix Gap uses the identical per-row formula one level up:
 *   mixGapPts = saleMixPct − stockMixPct  →  ΣsaleMixPct − ΣstockMixPct
 * so it is 0.0pp unfiltered, and a real net over/under-stock gap otherwise.
 */
function buildTotalRow(rows: AttributeMixRow[], attributeCount: number): AttributeMixRow[] {
  if (rows.length === 0) return [];
  let sales = 0;
  let soh = 0;
  let warehouseAvailable = 0;
  let saleMixPct = 0;
  let stockMixPct = 0;
  for (const r of rows) {
    sales += r.sales;
    soh += r.soh;
    warehouseAvailable += r.warehouseAvailable;
    saleMixPct += r.saleMixPct;
    stockMixPct += r.stockMixPct;
  }
  return [
    {
      // One entry per combo column so the leading cells render blank
      // rather than `undefined` (the attribute columns read values[i]).
      values: Array.from({ length: Math.max(1, attributeCount) }, (_, i) => (i === 0 ? "Total" : "")),
      sales,
      saleMixPct,
      soh,
      stockMixPct,
      mixGapPts: saleMixPct - stockMixPct,
      warehouseAvailable,
      status: "balanced",
      negativeStock: false,
    },
  ];
}

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
          // The pinned grand-total row carries a placeholder status; an
          // "action" for a total is meaningless, so leave the cell empty.
          if (p.node.rowPinned) return null;
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

  const totalRow = useMemo(() => buildTotalRow(rows, attributes.length), [rows, attributes.length]);

  return (
    <DataGrid<AttributeMixRow>
      // Forces a full remount whenever the combo changes column COUNT/order
      // (e.g. Gender -> Gender+Size). Columns here have no `field`, only
      // `valueGetter` (there's no single flat property to point at — each
      // combo position holds a different attribute), and AG Grid's internal
      // column-state reconciliation across a columnDefs change got
      // confused by that shape change, leaving stale/blank cells in some
      // rows until a manual interaction forced a redraw. A key on the
      // combo's own identity sidesteps whatever internal state it was
      // carrying over, at the cost of losing sort/scroll position on
      // switch — an acceptable trade for a table that just changed what
      // it's showing entirely.
      key={attributes.join("+")}
      animateRows={false}
      rowData={rows}
      columnDefs={columnDefs}
      heightPx={Math.min(680, Math.max(200, 46 + rows.length * 40 + 40)) /* +40 = the pinned grand-total row, so adding it does not steal a data row's worth of visible space */}
      getRowId={(p) => p.data.values.join("|")}
      pinnedBottomRowData={totalRow}
      getRowStyle={(p) => (p.node.rowPinned === "bottom" ? TOTAL_ROW_STYLE : undefined)}
      overlayNoRowsTemplate={`No ${comboLabel.toLowerCase()} groups match this scope.`}
    />
  );
}
