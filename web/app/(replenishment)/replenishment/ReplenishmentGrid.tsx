"use client";

import { useMemo, useRef, useState, useEffect } from "react";
import type { ColDef, GridApi, ICellRendererParams } from "ag-grid-community";
import { DataGrid } from "@/components/ui/DataGrid";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Priority, Trend, Row } from "@/lib/replenishment/compute";
import type { GroupHeaderRow } from "@/components/ui/FacetFilterBar";

// Group-by (Phase 1 of the faceted-filtering system) interleaves
// GroupHeaderRow markers into `rows` — rendered as a colSpan banner row
// (the first column's cell spans every column via colDef.colSpan, a
// standard AG Grid Community technique for inserting section headers into
// a flat grid). isFullWidthRow/fullWidthCellRenderer were tried first and,
// despite matching the documented v36 API shape, never actually rendered
// anything live (confirmed: 0 .ag-full-width-row elements despite the
// group rows being present in aria-rowcount) — colSpan is the more
// reliably-supported path and what's kept. Real Row entries render through
// the normal columnDefs completely unchanged. Optional and additive: the
// Workspace Builder's caller (renderReplenishmentComponents.tsx) never
// passes `rows` containing group headers, so its rendering is
// byte-identical to before this was added.
export type GridRow = Row | GroupHeaderRow;

function isGroupHeader(row: GridRow | undefined): row is GroupHeaderRow {
  return !!row && "__groupHeader" in row && row.__groupHeader === true;
}

// compute.ts is "server-only" — fmt/fmt1 can't be imported as values into
// this client component (webpack includes the whole module graph for a
// runtime import, even if only these two trivial helpers are used), so
// they're duplicated here rather than pulled in. Same formulas as compute.ts.
function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-IN");
}
function fmt1(n: number): string {
  return n.toFixed(1);
}

const PRIORITY_META: Record<Priority, { label: string; dot: string; className: string }> = {
  critical: { label: "Critical", dot: "🔴", className: "text-crit font-semibold" },
  high: { label: "High", dot: "🟠", className: "text-warn font-semibold" },
  medium: { label: "Medium", dot: "🟡", className: "text-ink-2" },
  healthy: { label: "Healthy", dot: "🟢", className: "text-good" },
  exhausted: { label: "Exhausted", dot: "⚫", className: "text-ink-3" },
};
const TREND_META: Record<Trend, { label: string; className: string }> = {
  accelerating: { label: "↑ Accelerating", className: "text-good" },
  stable: { label: "→ Stable", className: "text-ink-3" },
  declining: { label: "↓ Declining", className: "text-crit" },
};

/**
 * 2026-08-20 — same AG Grid conversion StoreLeagueDrilldown.tsx did for the
 * Workspace's Store League table (Objective.md flagged this page explicitly
 * as the next natural candidate: it's the densest table in the app and the
 * exact "wall of rows at scale" problem the Scale target section calls out).
 *
 * The "why" + size-breakdown detail that used to live in a per-row
 * <details> (awkward inside a virtualized grid row) opens in a Dialog on
 * row click instead, reusing the exact pattern the Store League drilldown
 * established.
 *
 * Server-side what-if recompute (target cover/lead time/safety/score
 * weights) in page.tsx is still a real server round-trip — those change
 * the underlying numbers, not just which rows are displayed. Display
 * filtering/search/pagination is NOT server-side anymore for the Movement
 * tab that uses this (see ReplenishmentFacetedContent.tsx, Phase 1 of the
 * faceted-filtering system) — this grid just renders whatever full or
 * grouped row array its caller hands it, with AG Grid's own virtualized
 * scrolling handling row count instead of a manual pager. The Workspace
 * Builder's caller (renderReplenishmentComponents.tsx) still passes a
 * plain, small, pre-filtered Row[] with no grouping — unaffected either
 * way.
 */
export function ReplenishmentGrid({ rows, preserveOrder }: { rows: GridRow[]; preserveOrder?: boolean }) {
  const [detailRow, setDetailRow] = useState<Row | null>(null);
  const [open, setOpen] = useState(false);
  const gridApiRef = useRef<GridApi<GridRow> | null>(null);

  // colDef's declarative `sort: "desc"` only sets the INITIAL sort at
  // mount — toggling it off in a later columnDefs update does not
  // retroactively clear an already-active sort on a live grid instance
  // (confirmed live: group-by kept showing score-descending order despite
  // preserveOrder correctly removing `sort` from the colDef). Clearing/
  // restoring it imperatively via the grid API on `preserveOrder` change is
  // what actually works.
  useEffect(() => {
    const api = gridApiRef.current;
    if (!api) return;
    if (preserveOrder) {
      api.applyColumnState({ defaultState: { sort: null } });
    } else {
      api.applyColumnState({ state: [{ colId: "score", sort: "desc" }], defaultState: { sort: null } });
    }
  }, [preserveOrder]);

  // Kept typed against Row (field: "priority" etc. need Row's own keys) —
  // cast to ColDef<GridRow>[] only where passed to DataGrid below, since
  // AG Grid never applies these column defs to a full-width group row.
  const columnDefs = useMemo<ColDef<Row>[]>(
    () => [
      {
        field: "priority",
        headerName: "Priority",
        flex: 1.1,
        sortable: true,
        // colSpan makes this cell cover every column for a group-header
        // row (see the file header) — the standard AG Grid Community
        // banner-row technique. `colDef` typed against Row throughout, but
        // this callback receives the real GridRow union at runtime, so
        // it's annotated explicitly here rather than inheriting Row.
        colSpan: (p: { data?: GridRow }) => (isGroupHeader(p.data) ? 14 : 1), // 14 = total column count below
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
          const meta = PRIORITY_META[(p.data as Row).priority];
          return <span className={meta.className}>{meta.dot} {meta.label}</span>;
        },
      },
      {
        field: "score",
        headerName: "Score",
        flex: 0.7,
        sortable: true,
        // No default active sort while preserveOrder is set (group-by is
        // active) — AG Grid's client-side row model re-sorts the FULL
        // rowData array (including GroupHeaderRow markers, which have no
        // .score) by any column carrying an active `sort`, which would
        // otherwise scatter group headers away from their own rows and
        // silently defeat buildGroupedRows' ordering. Still `sortable:
        // true` either way, so a user can click the header manually.
        ...(preserveOrder ? {} : { sort: "desc" as const }),
        cellClass: "text-right font-mono text-ink-3",
        headerClass: "text-right",
        valueFormatter: (p) => fmt1(p.value),
      },
      { field: "styleNo", headerName: "Style No.", flex: 1, sortable: true, cellClass: "font-mono text-[11.5px]" },
      { field: "color", headerName: "Color", flex: 0.9, sortable: true, cellClass: "text-ink-2" },
      { field: "storeName", headerName: "Store", flex: 1.1, sortable: true, cellClass: "text-ink-2" },
      { field: "soh", headerName: "SOH", flex: 0.7, sortable: true, cellClass: "text-right font-mono", headerClass: "text-right", valueFormatter: (p) => fmt(p.value) },
      { field: "dailyDemand", headerName: "Daily demand", flex: 0.9, sortable: true, cellClass: "text-right font-mono", headerClass: "text-right", valueFormatter: (p) => fmt1(p.value) },
      {
        field: "trend",
        headerName: "Trend",
        flex: 1,
        sortable: true,
        cellRenderer: (p: ICellRendererParams<Row>) => {
          const t = p.data!.trend;
          return t ? <span className={TREND_META[t].className}>{TREND_META[t].label}</span> : <span>—</span>;
        },
      },
      { field: "coverDays", headerName: "Cover", flex: 0.7, sortable: true, cellClass: "text-right font-mono", headerClass: "text-right", valueFormatter: (p) => (p.value === null ? "—" : `${fmt1(p.value)}d`) },
      { field: "reorderPoint", headerName: "Reorder pt", flex: 0.8, sortable: true, cellClass: "text-right font-mono text-ink-3", headerClass: "text-right", valueFormatter: (p) => fmt(p.value) },
      { field: "targetStock", headerName: "Target", flex: 0.8, sortable: true, cellClass: "text-right font-mono text-ink-3", headerClass: "text-right", valueFormatter: (p) => fmt(p.value) },
      { field: "recommendedQty", headerName: "Recommended", flex: 1, sortable: true, cellClass: "text-right font-mono font-semibold", headerClass: "text-right", valueFormatter: (p) => (p.value > 0 ? fmt(p.value) : "—") },
      { field: "source", headerName: "Source", flex: 1.3, cellClass: "text-ink-2" },
      { field: "action", headerName: "Action", flex: 1.3, sortable: true, cellClass: "font-medium text-ink-2" },
    ],
    [preserveOrder]
  );

  return (
    <>
      {/* rowData may now include GroupHeaderRow markers (Phase 1 of the
          faceted-filtering system, group-by) rendered as a colSpan banner
          via the priority column above — real rows still render through
          columnDefs completely unchanged. columnDefs stays typed against
          Row (its field names need Row's own keys); cast here only. */}
      <DataGrid<GridRow>
        rowData={rows}
        columnDefs={columnDefs as unknown as ColDef<GridRow>[]}
        heightPx={Math.min(640, Math.max(160, 46 + rows.length * 40))}
        getRowId={(p) => (isGroupHeader(p.data) ? p.data.id : `${p.data.styleNo}|${p.data.color}|${p.data.storeId}`)}
        onGridReady={(e) => {
          gridApiRef.current = e.api;
          if (preserveOrder) e.api.applyColumnState({ defaultState: { sort: null } });
        }}
        onRowClicked={(e) => e.data && !isGroupHeader(e.data) && (setDetailRow(e.data), setOpen(true))}
        rowStyle={{ cursor: "pointer" }}
        overlayNoRowsTemplate="No style-colors match these filters."
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {detailRow ? `${detailRow.styleNo} · ${detailRow.color} — ${detailRow.storeName}` : ""}
            </DialogTitle>
          </DialogHeader>
          {detailRow && (
            <div className="mt-2">
              <div className={`text-[12.5px] font-medium ${PRIORITY_META[detailRow.priority].className}`}>
                {detailRow.action}
              </div>
              <p className="mt-1 text-[12.5px] text-ink-3">{detailRow.why}</p>
              {detailRow.sizeBreakdown.length > 0 && (
                <div className="mt-3">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-3">Size breakdown (30d sales)</div>
                  <table className="mt-1 w-full text-[11.5px]">
                    <thead>
                      <tr className="text-left text-ink-3">
                        <th className="pr-2 py-1">Size</th>
                        <th className="pr-2 py-1 text-right">SOH</th>
                        <th className="pr-2 py-1 text-right">30D</th>
                        <th className="py-1 text-right">Velocity</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailRow.sizeBreakdown.map((s) => {
                        const lowStockHighDemand = s.soh <= 1 && s.sales30d >= 3;
                        return (
                          <tr key={s.size} className={lowStockHighDemand ? "text-crit font-semibold" : "text-ink-2"}>
                            <td className="pr-2 py-1">{s.size}</td>
                            <td className="pr-2 py-1 text-right font-mono">{fmt(s.soh)}</td>
                            <td className="pr-2 py-1 text-right font-mono">{fmt(s.sales30d)}</td>
                            <td className="py-1 text-right font-mono">{fmt1(s.velocity)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
