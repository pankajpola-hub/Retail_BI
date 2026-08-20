"use client";

import { useState, useMemo } from "react";
import type { ColDef } from "ag-grid-community";
import { getStoreDrilldownTrend } from "@/lib/workspace/drilldown";
import { TrendChart } from "@/components/ui/TrendChart";
import { DataGrid } from "@/components/ui/DataGrid";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type LeagueRow = {
  storeId: string;
  name: string;
  net: number;
  bills: number;
  qty: number;
  atv: number | null;
  upt: number | null;
  discountPct: number | null;
};

type Point = { label: string; value: number };
type DrilldownState =
  | { status: "loading"; storeId: string; name: string }
  | { status: "loaded"; storeId: string; name: string; points: Point[] }
  | { status: "error"; storeId: string; name: string; message: string };

const INR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/**
 * Phase 8 smart component + 2026-08-15 UI foundation pass: the store
 * league table is now a real AG Grid (sortable/resizable columns,
 * virtualized rows — see DataGrid.tsx) instead of a plain <table>, and a
 * row click opens a Radix Dialog (real focus trap/ESC/portal, replacing a
 * hand-rolled fixed-overlay div) showing that store's own daily net-sales
 * trend — fetched ONLY on click (getStoreDrilldownTrend), never eagerly.
 * That lazy-fetch behavior is unchanged from the original Phase 8 build —
 * this pass only replaced the two hand-rolled UI primitives around it.
 */
export function StoreLeagueDrilldown({ league, from, to }: { league: LeagueRow[]; from: string; to: string }) {
  const [drilldown, setDrilldown] = useState<DrilldownState | null>(null);
  const [open, setOpen] = useState(false);

  async function openDrilldown(storeId: string, name: string) {
    setOpen(true);
    setDrilldown({ status: "loading", storeId, name });
    try {
      const points = await getStoreDrilldownTrend(storeId, from, to);
      setDrilldown({ status: "loaded", storeId, name, points });
    } catch (err) {
      setDrilldown({
        status: "error",
        storeId,
        name,
        message: err instanceof Error ? err.message : "Failed to load store detail.",
      });
    }
  }

  const columnDefs = useMemo<ColDef<LeagueRow>[]>(
    () => [
      { field: "name", headerName: "Store", flex: 1.4, sortable: true },
      {
        field: "net",
        headerName: "Net",
        flex: 1,
        sortable: true,
        sort: "desc",
        cellClass: "text-right font-mono",
        headerClass: "text-right",
        valueFormatter: (p) => INR(p.value),
      },
      {
        field: "bills",
        headerName: "Bills",
        flex: 0.7,
        sortable: true,
        cellClass: "text-right font-mono",
        headerClass: "text-right",
      },
      {
        field: "qty",
        headerName: "Units",
        flex: 0.7,
        sortable: true,
        cellClass: "text-right font-mono",
        headerClass: "text-right",
      },
      {
        field: "atv",
        headerName: "ATV",
        flex: 1,
        sortable: true,
        cellClass: "text-right font-mono",
        headerClass: "text-right",
        valueFormatter: (p) => (p.value !== null ? INR(p.value) : "—"),
      },
      {
        field: "upt",
        headerName: "UPT",
        flex: 0.8,
        sortable: true,
        cellClass: "text-right font-mono",
        headerClass: "text-right",
        valueFormatter: (p) => (p.value !== null ? p.value.toFixed(2) : "—"),
      },
      {
        field: "discountPct",
        headerName: "Disc",
        flex: 0.8,
        sortable: true,
        cellClass: "text-right font-mono",
        headerClass: "text-right",
        valueFormatter: (p) => (p.value !== null ? `${p.value.toFixed(1)}%` : "—"),
      },
    ],
    []
  );

  return (
    <>
      <DataGrid<LeagueRow>
        rowData={league}
        columnDefs={columnDefs}
        heightPx={Math.max(120, 46 + league.length * 40)}
        onRowClicked={(e) => e.data && openDrilldown(e.data.storeId, e.data.name)}
        rowStyle={{ cursor: "pointer" }}
        overlayNoRowsTemplate="No stores with sales in this window."
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{drilldown?.name ?? ""} — daily net sales</DialogTitle>
          </DialogHeader>

          <div className="mt-3 min-h-[100px]">
            {drilldown?.status === "loading" && <p className="text-sm text-ink-3">Loading…</p>}
            {drilldown?.status === "error" && (
              <p className="border-l-2 border-crit bg-crit-soft px-3 py-2 text-sm text-ink-2">{drilldown.message}</p>
            )}
            {drilldown?.status === "loaded" && drilldown.points.length > 0 && (
              <TrendChart points={drilldown.points} ariaLabel={`Daily net sales for ${drilldown.name}`} />
            )}
            {drilldown?.status === "loaded" && drilldown.points.length === 0 && (
              <p className="py-6 text-center text-sm text-ink-3">No sales data for this store in this window.</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
