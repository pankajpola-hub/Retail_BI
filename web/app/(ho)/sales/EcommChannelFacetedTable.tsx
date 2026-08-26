"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { DataGrid } from "@/components/ui/DataGrid";
import {
  FacetFilterBar,
  applyFacetFilter,
  emptyFilterState,
  type FacetDef,
  type AdvField,
  type FacetFilterState,
} from "@/components/ui/FacetFilterBar";

const INR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const PCT = (n: number | null) => (n === null ? "—" : `${n.toFixed(1)}%`);

const PAGE_KEY = "sales_ecomm_channel";

export type EcommChannelRow = {
  channel: string;
  orders: number;
  cancelled: number;
  cancellationRate: number | null;
  units: number;
  net: number;
  mrp: number;
  discountPct: number | null;
};

/**
 * Phase 1 polish pass (2026-08-26) — replaces EcommDetailSection's
 * hand-rolled "By channel" <table> with the same FacetFilterBar + DataGrid
 * engine as WeeklySalesFacetedTable. No group-by (channel already IS the
 * row grain — grouping by itself would just collapse the grid to what it
 * already shows). The pre-existing row-click -> SKU drill-down
 * (`channelHref`, the single-value `channel` searchParam) is preserved as
 * a link inside the Channel cell rather than an onRowClicked handler, so
 * a click still navigates the same way it always has.
 */
export function EcommChannelFacetedTable({
  rows,
  activeChannel,
  channelHref,
}: {
  rows: EcommChannelRow[];
  activeChannel: string | null;
  channelHref: (target: string | null) => string;
}) {
  const [state, setState] = useState<FacetFilterState>(emptyFilterState);

  const facets = useMemo<FacetDef<EcommChannelRow>[]>(() => [{ key: "channel", label: "Channel", get: (r) => r.channel }], []);

  const advFields = useMemo<AdvField<EcommChannelRow>[]>(
    () => [
      { key: "orders", label: "Orders", get: (r) => r.orders, numeric: true },
      { key: "cancelled", label: "Cancelled orders", get: (r) => r.cancelled, numeric: true },
      { key: "cancellationRate", label: "Cancellation rate %", get: (r) => r.cancellationRate, numeric: true },
      { key: "units", label: "Units", get: (r) => r.units, numeric: true },
      { key: "net", label: "Net value", get: (r) => r.net, numeric: true },
      { key: "mrp", label: "MRP value", get: (r) => r.mrp, numeric: true },
      { key: "discountPct", label: "Discount %", get: (r) => r.discountPct, numeric: true },
    ],
    []
  );

  const filtered = useMemo(() => applyFacetFilter(rows, facets, [], state), [rows, facets, state]);

  const columnDefs = useMemo<ColDef<EcommChannelRow>[]>(
    () => [
      {
        field: "channel",
        headerName: "Channel",
        flex: 1.2,
        sortable: true,
        cellRenderer: (p: ICellRendererParams<EcommChannelRow>) => {
          const ch = p.data!.channel;
          const active = activeChannel === ch;
          return (
            <Link href={channelHref(active ? null : ch)} className={`hover:underline ${active ? "font-semibold text-accent-ink" : ""}`}>
              {ch}
            </Link>
          );
        },
      },
      { field: "orders", headerName: "Orders", flex: 0.7, sortable: true, cellClass: "text-right font-mono", headerClass: "text-right" },
      { field: "cancelled", headerName: "Cancelled", flex: 0.7, sortable: true, cellClass: "text-right font-mono", headerClass: "text-right" },
      { field: "cancellationRate", headerName: "Cancel %", flex: 0.7, sortable: true, cellClass: "text-right font-mono", headerClass: "text-right", valueFormatter: (p) => PCT(p.value) },
      { field: "units", headerName: "Units", flex: 0.7, sortable: true, cellClass: "text-right font-mono", headerClass: "text-right" },
      { field: "net", headerName: "Net value", flex: 0.9, sortable: true, cellClass: "text-right font-mono", headerClass: "text-right", valueFormatter: (p) => INR(p.value) },
      { field: "mrp", headerName: "MRP value", flex: 0.9, sortable: true, cellClass: "text-right font-mono", headerClass: "text-right", valueFormatter: (p) => INR(p.value) },
      { field: "discountPct", headerName: "Discount %", flex: 0.7, sortable: true, cellClass: "text-right font-mono", headerClass: "text-right", valueFormatter: (p) => PCT(p.value) },
    ],
    [activeChannel, channelHref]
  );

  return (
    <>
      <FacetFilterBar pageKey={PAGE_KEY} rows={rows} facets={facets} advFields={advFields} groupByOptions={[]} state={state} onChange={setState} />
      <div className="mb-2 text-[12px] text-ink-3">
        {filtered.length === rows.length ? `${filtered.length} rows` : `${filtered.length} of ${rows.length} rows`}
      </div>
      <DataGrid<EcommChannelRow>
        animateRows={false}
        rowData={filtered}
        columnDefs={columnDefs}
        heightPx={Math.min(480, Math.max(160, 46 + filtered.length * 38))}
        getRowId={(p) => p.data.channel}
        overlayNoRowsTemplate="No channels match these filters."
      />
    </>
  );
}
