"use client";

import { useMemo } from "react";
import type { ColDef, ValueGetterParams } from "ag-grid-community";
import { DataGrid } from "@/components/ui/DataGrid";
import type { ReplAttributeRow } from "@/lib/replenishment/replAttributes";
import { ATTRIBUTE_COLUMN_LABELS, type AttributeKey } from "@/lib/replenishment/replAttributes";

const fmt = (n: number) => Math.round(n).toLocaleString("en-IN");
const fmt1 = (n: number) => n.toFixed(1);

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
      heightPx={Math.min(640, Math.max(160, 46 + rows.length * 40))}
      getRowId={(p) => p.data.values.join("|")}
      overlayNoRowsTemplate={`No ${comboLabel.toLowerCase()} groups match this scope.`}
    />
  );
}
