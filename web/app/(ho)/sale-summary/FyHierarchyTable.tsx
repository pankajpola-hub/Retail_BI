"use client";

import { useMemo, useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import type { ColDef, ColGroupDef, ICellRendererParams, RowStyle } from "ag-grid-community";
import { DataGrid } from "@/components/ui/DataGrid";
import type { FyHierarchyRow, FyCell } from "@/lib/saleSummary/fyHierarchy";
import { fmtInrAbbrev, fmtCount } from "@/lib/saleSummary/format";

const GRAND_TOTAL_ID = "grand-total";

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
 *
 * Two totals (2026-09-16, per Pankaj: "Subtotal in header and at right side
 * end"):
 *  - A GRAND TOTAL ROW pinned to the top via AG Grid's pinnedTopRowData —
 *    sits directly under the column headers, network-wide Qty/Gross per FY.
 *    Summed from the level-0 (Channel Model) rows, which are themselves
 *    already full per-model sums, so adding them across models double-counts
 *    nothing.
 *  - A "Total" column GROUP appended after every FY group — each row's own
 *    Qty/Gross summed ACROSS all financial years, so a row's full-history
 *    total is readable without adding up every FY column by eye.
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

  // Network-wide total per FY, summed from the level-0 (Channel Model) rows
  // — each already a full per-model sum, so this double-counts nothing.
  const grandTotalRow = useMemo<FyHierarchyRow>(() => {
    const byFy: Record<string, FyCell> = {};
    for (const fy of financialYears) byFy[fy] = { qty: 0, gross: 0 };
    for (const r of rows) {
      if (r.level !== 0) continue;
      for (const fy of financialYears) {
        byFy[fy]!.qty += r.byFy[fy]?.qty ?? 0;
        byFy[fy]!.gross += r.byFy[fy]?.gross ?? 0;
      }
    }
    return { id: GRAND_TOTAL_ID, level: 0, label: "Grand Total", channelModel: "", channelType: null, channelName: null, childCount: 0, byFy };
  }, [rows, financialYears]);

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
        if (row.id === GRAND_TOTAL_ID) {
          return <span className="font-semibold">{row.label}</span>;
        }
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

    // Right-side-end "Total" column group — each row's Qty/Gross summed
    // across every FY, so the full-history total per row doesn't need to be
    // added up across the FY columns by eye.
    const totalGroup: ColGroupDef<FyHierarchyRow> = {
      headerName: "Total",
      children: [
        {
          colId: "total:qty",
          headerName: "Qty",
          width: 100,
          sortable: false,
          cellClass: "text-right font-mono font-semibold",
          headerClass: "text-right",
          valueGetter: (p) => financialYears.reduce((s, fy) => s + (p.data?.byFy[fy]?.qty ?? 0), 0),
          valueFormatter: (p) => fmtCount(p.value as number),
        },
        {
          colId: "total:gross",
          headerName: "Gross (taxable)",
          width: 130,
          sortable: false,
          cellClass: "text-right font-mono font-semibold",
          headerClass: "text-right",
          valueGetter: (p) => financialYears.reduce((s, fy) => s + (p.data?.byFy[fy]?.gross ?? 0), 0),
          valueFormatter: (p) => fmtInrAbbrev(p.value as number),
        },
      ] as ColDef<FyHierarchyRow>[],
    };

    return [labelCol, ...fyGroups, totalGroup];
  }, [expandedTypes, financialYears]);

  return (
    <DataGrid<FyHierarchyRow>
      rowData={visibleRows}
      pinnedTopRowData={[grandTotalRow]}
      columnDefs={columnDefs}
      getRowStyle={(p) => LEVEL_ROW_STYLE[(p.data?.level ?? 2) as 0 | 1 | 2]}
      getRowId={(p) => p.data.id}
      heightPx={Math.min(640, Math.max(160, 46 + visibleRows.length * 36))}
      overlayNoRowsTemplate="No data."
    />
  );
}
