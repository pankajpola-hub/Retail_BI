"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
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
}: {
  rows: EcommChannelRow[];
  activeChannel: string | null;
}) {
  const [state, setState] = useState<FacetFilterState>(emptyFilterState);
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Built client-side rather than accepted as a function prop — a Server
  // Component passing a closure to a "use client" component fails at
  // render time (functions aren't serializable across the RSC boundary).
  // Same "clone current searchParams, set/delete one key" shape
  // StoreFilter/MultiSelectFilter already use elsewhere on this page.
  function channelHref(target: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (target) params.set("channel", target);
    else params.delete("channel");
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }

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

  /**
   * Grand-total row, pinned to the bottom, computed from `filtered` so it
   * follows the active facet filters. Channels partition the order lines, so
   * orders/cancelled/units/net/mrp all sum cleanly.
   *
   * Both ratios are recomputed from the summed numerator and denominator with
   * the exact formulas page.tsx:957/960 builds each row with — never an
   * average of the per-row percentages:
   *   Cancel %   = 100 * Σcancelled / Σorders      (null when Σorders  == 0)
   *   Discount % = 100 * Σdiscount  / Σmrp         (null when Σmrp     == 0)
   * `discount` is not carried on the row, but it is exactly Σ(mrp * pct/100)
   * per channel, which reconstructs the numerator with no loss.
   */
  const pinnedTotal = useMemo<EcommChannelRow[]>(() => {
    if (filtered.length === 0) return [];
    let orders = 0;
    let cancelled = 0;
    let units = 0;
    let net = 0;
    let mrp = 0;
    let discount = 0;
    for (const r of filtered) {
      orders += r.orders;
      cancelled += r.cancelled;
      units += r.units;
      net += r.net;
      mrp += r.mrp;
      discount += r.discountPct === null ? 0 : (r.mrp * r.discountPct) / 100;
    }
    return [
      {
        channel: "Total",
        orders,
        cancelled,
        cancellationRate: orders > 0 ? (100 * cancelled) / orders : null,
        units,
        net,
        mrp,
        discountPct: mrp > 0 ? (100 * discount) / mrp : null,
      },
    ];
  }, [filtered]);

  const columnDefs = useMemo<ColDef<EcommChannelRow>[]>(
    () => [
      {
        field: "channel",
        headerName: "Channel",
        flex: 1.2,
        sortable: true,
        cellRenderer: (p: ICellRendererParams<EcommChannelRow>) => {
          const ch = p.data!.channel;
          // The pinned grand total is not a channel — no drill-down link.
          if (p.node.rowPinned === "bottom") return <span className="font-bold">{ch}</span>;
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
        pinnedBottomRowData={pinnedTotal}
        heightPx={Math.min(480, Math.max(160, 46 + filtered.length * 38)) + (pinnedTotal.length > 0 ? 40 : 0)}
        getRowStyle={(p) =>
          p.node.rowPinned === "bottom"
            ? { background: "var(--surface-2)", fontWeight: 700, borderTop: "2px solid var(--line)" }
            : undefined
        }
        getRowId={(p) => p.data.channel}
        overlayNoRowsTemplate="No channels match these filters."
      />
    </>
  );
}
