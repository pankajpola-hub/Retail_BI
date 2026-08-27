"use client";

import { useMemo } from "react";
import type { ColDef, ValueGetterParams } from "ag-grid-community";
import { DataGrid } from "@/components/ui/DataGrid";
import type { ReplAttributeRow } from "@/lib/replenishment/replAttributes";
import { ATTRIBUTE_COLUMN_LABELS, type AttributeKey } from "@/lib/replenishment/replAttributes";

const fmt = (n: number) => Math.round(n).toLocaleString("en-IN");
const fmt1 = (n: number) => n.toFixed(1);

// Pinned grand-total row styling — same treatment as the sibling mix grids.
const TOTAL_ROW_STYLE = {
  background: "var(--surface-2)",
  fontWeight: 600,
  borderTop: "2px solid var(--line)",
} as const;

/**
 * Grand total over the rows currently supplied (already facet-filtered by
 * the caller, so the footer follows the filters).
 *
 * Sales (30d), Daily demand, Store SOH and WH SOH are plain sums — all four
 * are extensive unit counts.
 *
 * Cover is a RATE and is recomputed, never averaged. replAttributes.ts:60
 * defines it per row as:
 *   coverDays = dailyDemand > 0 ? soh / dailyDemand : soh > 0 ? null : 0
 * The footer uses that same expression on the summed inputs:
 *   Cover = ΣdailyDemand > 0 ? Σsoh / ΣdailyDemand : Σsoh > 0 ? null : 0
 * so zero total demand with stock on hand renders "—" (infinite cover, the
 * column's existing null convention) and zero-demand/zero-stock renders
 * 0.0d — no NaN and no Infinity is reachable.
 */
function buildTotalRow(rows: ReplAttributeRow[], attributeCount: number): ReplAttributeRow[] {
  if (rows.length === 0) return [];
  let sales30d = 0;
  let dailyDemand = 0;
  let soh = 0;
  let warehouseAvailable = 0;
  for (const r of rows) {
    sales30d += r.sales30d;
    dailyDemand += r.dailyDemand;
    soh += r.soh;
    warehouseAvailable += r.warehouseAvailable;
  }
  return [
    {
      values: Array.from({ length: Math.max(1, attributeCount) }, (_, i) => (i === 0 ? "Total" : "")),
      soh,
      warehouseAvailable,
      sales30d,
      dailyDemand,
      coverDays: dailyDemand > 0 ? soh / dailyDemand : soh > 0 ? null : 0,
    },
  ];
}

/**
 * Sibling to ../movement/AttributeMixGrid.tsx — same combo-column technique
 * (one leading grid column per attribute in the combo, independently
 * sortable), for the Replenishment tab's own "View by" bar. Diagnostic
 * columns only (stock vs demand) — see replAttributes.ts's own header for
 * why recommendedQty isn't shown at this grain.
 */
export function AttributeReplenishmentGrid({ rows, attributes }: { rows: ReplAttributeRow[]; attributes: AttributeKey[] }) {
  const columnDefs = useMemo<ColDef<ReplAttributeRow>[]>(() => {
    const attributeCols: ColDef<ReplAttributeRow>[] = attributes.map((attr, i) => ({
      headerName: ATTRIBUTE_COLUMN_LABELS[attr],
      flex: 1,
      sortable: true,
      valueGetter: (p: ValueGetterParams<ReplAttributeRow>) => p.data?.values[i] ?? "",
    }));

    return [
      ...attributeCols,
      { field: "sales30d", headerName: "Sales (30d)", flex: 0.9, sortable: true, cellClass: "text-right font-mono", headerClass: "text-right", valueFormatter: (p) => fmt(p.value) },
      { field: "dailyDemand", headerName: "Daily demand", flex: 0.9, sortable: true, cellClass: "text-right font-mono", headerClass: "text-right", valueFormatter: (p) => fmt1(p.value) },
      { field: "soh", headerName: "Store SOH", flex: 0.9, sortable: true, cellClass: "text-right font-mono", headerClass: "text-right", valueFormatter: (p) => fmt(p.value) },
      { field: "warehouseAvailable", headerName: "WH SOH", flex: 0.9, sortable: true, cellClass: "text-right font-mono", headerClass: "text-right", valueFormatter: (p) => fmt(p.value) },
      {
        field: "coverDays",
        headerName: "Cover",
        flex: 0.8,
        sortable: true,
        cellClass: "text-right font-mono text-ink-3",
        headerClass: "text-right",
        valueFormatter: (p) => (p.value === null ? "—" : `${fmt1(p.value)}d`),
      },
    ];
  }, [attributes]);

  const comboLabel = attributes.map((a) => ATTRIBUTE_COLUMN_LABELS[a]).join(" + ");

  const totalRow = useMemo(() => buildTotalRow(rows, attributes.length), [rows, attributes.length]);

  return (
    <DataGrid<ReplAttributeRow>
      // Same full-remount-on-combo-change technique as AttributeMixGrid —
      // columns here have no `field`, only `valueGetter`, and AG Grid's
      // column-state reconciliation gets confused across a shape change
      // without this.
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
