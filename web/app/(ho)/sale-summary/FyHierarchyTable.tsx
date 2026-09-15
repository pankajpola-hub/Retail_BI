"use client";

import { useMemo, useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import type { ColDef, ColGroupDef, ICellRendererParams, RowStyle } from "ag-grid-community";
import { DataGrid } from "@/components/ui/DataGrid";
import type { FyHierarchyRow } from "@/lib/saleSummary/fyHierarchy";
import { fmtInrAbbrev, fmtCount } from "@/lib/saleSummary/format";

const LEVEL_ROW_STYLE: Record<0 | 1 | 2, RowStyle> = {
  0: { background: "var(--surface-2)", fontWeight: 700, borderTop: "2px solid var(--line)" },
  1: { background: "var(--surface-2)", fontWeight: 600 },
  2: {},
};

/**
 * "All years at a glance" — Channel Model / Type / Name rows, one Qty +
 * Gross (taxable) column pair PER FINANCIAL YEAR (2026-09-15). Sits above
 * the page's own filtered content; unlike HierarchyTable this reads the
 * FULL, unfiltered history — see FyHierarchyTable's caller in page.tsx and
 * lib/saleSummary/fyHierarchy.ts's header for why.
 *
 * Same expand/collapse shape as HierarchyTable.tsx (Model and Type rows
 * always visible, a Type's Channel Name rows only render once that Type is
 * expanded) — kept consistent with the page's one other hierarchy table
 * rather than inventing a second interaction pattern. Column groups (one
 * per FY, AG Grid Community's own grouped-header support — not an
 * Enterprise feature) give the merged year header cells the reference
 * mockup showed.
 */
export function FyHierarchyTable({ rows, financialYears }: { rows: FyHierarchyRow[]; financialYears: string[] }) {
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set());

  function toggleType(id: string) {
    setExpandedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const visibleRows = useMemo(
    () =>
      rows.filter((r) => {
        if (r.level !== 2) return true;
        const parentTypeId = `type:${r.channelModel} ${r.channelType}`;
        return expandedTypes.has(parentTypeId);
      }),
    [rows, expandedTypes]
  );

  const columnDefs = useMemo<(ColDef<FyHierarchyRow> | ColGroupDef<FyHierarchyRow>)[]>(() => {
    const labelCol: ColDef<FyHierarchyRow> = {
      field: "label",
      headerName: "Channel Model / Type / Name",
      pinned: "left",
      width: 260,
      sortable: false,
      cellRenderer: (p: ICellRendererParams<FyHierarchyRow>) => {
        const row = p.data;
        if (!row) return null;
        const canExpand = row.level === 1 && row.childCount > 0;
        const isExpanded = expandedTypes.has(row.id);
        return (
          <div
            className={`flex h-full items-center gap-1.5 ${canExpand ? "cursor-pointer" : ""}`}
            style={{ paddingLeft: row.level * 18 }}
            onClick={canExpand ? () => toggleType(row.id) : undefined}
          >
            {canExpand ? (
              isExpanded ? (
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-3" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-3" />
              )
            ) : (
              <span className="inline-block w-3.5 shrink-0" />
            )}
            <span className={row.level === 0 ? "font-semibold" : row.level === 1 ? "font-medium" : "text-ink-2"}>{row.label}</span>
            {row.level < 2 && <span className="font-mono text-[11px] font-normal text-ink-3">({row.childCount})</span>}
          </div>
        );
      },
    };

    const fyGroups: ColGroupDef<FyHierarchyRow>[] = financialYears.map((fy) => ({
      headerName: fy,
      children: [
        {
          colId: `${fy}:qty`,
          headerName: "Qty",
          width: 100,
          sortable: false,
          cellClass: "text-right font-mono",
          headerClass: "text-right",
          valueGetter: (p) => p.data?.byFy[fy]?.qty ?? 0,
          valueFormatter: (p) => fmtCount(p.value as number),
        },
        {
          colId: `${fy}:gross`,
          headerName: "Gross (taxable)",
          width: 130,
          sortable: false,
          cellClass: "text-right font-mono",
          headerClass: "text-right",
          valueGetter: (p) => p.data?.byFy[fy]?.gross ?? 0,
          valueFormatter: (p) => fmtInrAbbrev(p.value as number),
        },
      ] as ColDef<FyHierarchyRow>[],
    }));

    return [labelCol, ...fyGroups];
  }, [expandedTypes, financialYears]);

  return (
    <DataGrid<FyHierarchyRow>
      rowData={visibleRows}
      columnDefs={columnDefs}
      getRowStyle={(p) => LEVEL_ROW_STYLE[(p.data?.level ?? 2) as 0 | 1 | 2]}
      getRowId={(p) => p.data.id}
      heightPx={Math.min(640, Math.max(160, 46 + visibleRows.length * 36))}
      overlayNoRowsTemplate="No data."
    />
  );
}
