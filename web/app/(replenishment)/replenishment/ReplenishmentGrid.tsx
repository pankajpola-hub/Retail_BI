"use client";

import { useMemo, useState } from "react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { DataGrid } from "@/components/ui/DataGrid";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Priority, Trend, Row } from "@/lib/replenishment/compute";

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
 * Server-side filtering/pagination/what-if recompute in page.tsx is
 * UNCHANGED — this component only replaces the <table> markup for whatever
 * page of rows the server already sliced (`pageRows`), same as before. The
 * "why" + size-breakdown detail that used to live in a per-row <details>
 * (awkward inside a virtualized grid row) now opens in a Dialog on row
 * click, reusing the exact pattern the Store League drilldown established.
 */
export function ReplenishmentGrid({ rows }: { rows: Row[] }) {
  const [detailRow, setDetailRow] = useState<Row | null>(null);
  const [open, setOpen] = useState(false);

  const columnDefs = useMemo<ColDef<Row>[]>(
    () => [
      {
        field: "priority",
        headerName: "Priority",
        flex: 1.1,
        sortable: true,
        cellRenderer: (p: ICellRendererParams<Row>) => {
          const meta = PRIORITY_META[p.data!.priority];
          return <span className={meta.className}>{meta.dot} {meta.label}</span>;
        },
      },
      { field: "score", headerName: "Score", flex: 0.7, sortable: true, sort: "desc", cellClass: "text-right font-mono text-ink-3", headerClass: "text-right", valueFormatter: (p) => fmt1(p.value) },
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
    []
  );

  return (
    <>
      {/* The server already sliced `rows` to the current page (page.tsx's
          own perPage/Pager controls, unchanged) — this grid just renders
          that slice with virtualized scrolling, no second pagination layer. */}
      <DataGrid<Row>
        rowData={rows}
        columnDefs={columnDefs}
        heightPx={Math.min(640, Math.max(160, 46 + rows.length * 40))}
        onRowClicked={(e) => e.data && (setDetailRow(e.data), setOpen(true))}
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
