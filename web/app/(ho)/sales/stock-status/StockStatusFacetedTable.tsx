"use client";

import { useMemo, useState } from "react";
import type { ColDef, ValueFormatterParams, CellClassParams, RowStyle } from "ag-grid-community";
import { DataGrid } from "@/components/ui/DataGrid";
import {
  FacetFilterBar,
  applyFacetFilter,
  emptyFilterState,
  type FacetDef,
  type AdvField,
  type FacetFilterState,
} from "@/components/ui/FacetFilterBar";
import type { StockStatusRow } from "@/lib/stockStatus/aggregate";

const PAGE_KEY = "sales_stock_status";

const MISMATCH_ROW_STYLE: RowStyle = { background: "var(--crit-soft)" };

function StatCard({ num, label, warn }: { num: number | string; label: string; warn?: boolean }) {
  return (
    <div className="rounded-md border border-line px-4 py-2.5">
      <div className={`text-lg font-serif ${warn ? "text-crit" : "text-ink"}`}>{num}</div>
      <div className="text-[11px] uppercase tracking-wide text-ink-3">{label}</div>
    </div>
  );
}

/**
 * WH stock vs Shopify SOH, per style/colour - ported from the Shopify
 * image-uploader project's Stock Status page
 * (D:\Py\Shopify image uploader\server\static\index.html, the "Stock
 * Status (WH vs Shopify)" section), same FacetFilterBar engine this app
 * already shares with every other faceted table here.
 */
export function StockStatusFacetedTable({ rows }: { rows: StockStatusRow[] }) {
  const [state, setState] = useState<FacetFilterState>(emptyFilterState);

  const facets = useMemo<FacetDef<StockStatusRow>[]>(
    () => [
      { key: "colour", label: "Colour", get: (r) => r.colour },
      { key: "status", label: "Shopify Status", get: (r) => r.status || "Unknown" },
      { key: "match", label: "Match", get: (r) => (r.match ? "Match" : "Mismatch") },
      { key: "onShopify", label: "On Shopify", get: (r) => (r.onShopify ? "Yes" : "No") },
      { key: "whHasData", label: "WH Data", get: (r) => (r.whHasData ? "Has WH data" : "No WH data") },
    ],
    []
  );

  const advFields = useMemo<AdvField<StockStatusRow>[]>(
    () => [
      { key: "style", label: "Style No.", get: (r) => r.style },
      { key: "title", label: "Product Title", get: (r) => r.title },
      { key: "colour", label: "Colour", get: (r) => r.colour },
      { key: "whStock", label: "WH Stock", get: (r) => r.whStock, numeric: true },
      { key: "shopifySoh", label: "Shopify SOH", get: (r) => r.shopifySoh, numeric: true },
      { key: "diff", label: "Difference (WH - Shopify)", get: (r) => r.diff, numeric: true },
    ],
    []
  );

  const filtered = useMemo(() => applyFacetFilter(rows, facets, advFields, state), [rows, facets, advFields, state]);

  const mismatchCount = useMemo(() => filtered.filter((r) => !r.match).length, [filtered]);
  const notOnShopifyCount = useMemo(() => filtered.filter((r) => !r.onShopify).length, [filtered]);
  const noWhDataCount = useMemo(() => filtered.filter((r) => !r.whHasData).length, [filtered]);
  const totalWh = useMemo(() => filtered.reduce((s, r) => s + (r.whHasData ? r.whStock : 0), 0), [filtered]);
  const totalShopify = useMemo(() => filtered.reduce((s, r) => s + (r.shopifyHasData ? r.shopifySoh : 0), 0), [filtered]);

  const columnDefs = useMemo<ColDef<StockStatusRow>[]>(
    () => [
      { field: "style", headerName: "Style", flex: 0.7, sortable: true, cellClass: "font-semibold" },
      { field: "title", headerName: "Product Title", flex: 1.5, sortable: true },
      { field: "colour", headerName: "Colour", flex: 0.8, sortable: true },
      {
        field: "whStock",
        headerName: "WH Stock",
        flex: 0.8,
        sortable: true,
        cellClass: "text-right font-mono",
        headerClass: "text-right",
        valueFormatter: (p: ValueFormatterParams<StockStatusRow, number>) => (p.data && !p.data.whHasData ? "—" : String(p.value)),
      },
      {
        field: "shopifySoh",
        headerName: "Shopify SOH",
        flex: 0.9,
        sortable: true,
        cellClass: "text-right font-mono",
        headerClass: "text-right",
        valueFormatter: (p: ValueFormatterParams<StockStatusRow, number>) => (p.data && !p.data.shopifyHasData ? "—" : String(p.value)),
      },
      {
        field: "diff",
        headerName: "Difference",
        flex: 0.8,
        sortable: true,
        cellClass: (p: CellClassParams<StockStatusRow, number>) =>
          `text-right font-mono ${(p.value ?? 0) > 0 ? "text-crit" : (p.value ?? 0) < 0 ? "text-warn" : ""}`,
        headerClass: "text-right",
        valueFormatter: (p: ValueFormatterParams<StockStatusRow, number>) => ((p.value ?? 0) > 0 ? `+${p.value}` : String(p.value)),
      },
      {
        field: "match",
        headerName: "Match?",
        flex: 0.6,
        sortable: true,
        cellClass: (p: CellClassParams<StockStatusRow, boolean>) => (p.value ? "text-good font-semibold" : "text-crit font-semibold"),
        valueFormatter: (p: ValueFormatterParams<StockStatusRow, boolean>) => (p.value ? "Yes" : "No"),
      },
      { field: "status", headerName: "Shopify Status", flex: 1, sortable: true },
    ],
    []
  );

  return (
    <>
      <div className="mb-4 flex flex-wrap gap-3">
        <StatCard num={filtered.length} label="style/colour rows" />
        <StatCard num={mismatchCount} label="mismatches" warn={mismatchCount > 0} />
        <StatCard num={totalWh.toLocaleString("en-IN")} label="total WH stock" />
        <StatCard num={totalShopify.toLocaleString("en-IN")} label="total Shopify SOH" />
        <StatCard num={notOnShopifyCount} label="not on Shopify" warn={notOnShopifyCount > 0} />
        <StatCard num={noWhDataCount} label="no WH data" warn={noWhDataCount > 0} />
      </div>

      <FacetFilterBar pageKey={PAGE_KEY} rows={rows} facets={facets} advFields={advFields} groupByOptions={[]} state={state} onChange={setState} />
      <div className="mb-2 text-[12px] text-ink-3">
        {filtered.length === rows.length ? `${filtered.length} rows` : `${filtered.length} of ${rows.length} rows`}
      </div>
      <DataGrid<StockStatusRow>
        animateRows={false}
        rowData={filtered}
        columnDefs={columnDefs}
        heightPx={Math.min(640, Math.max(160, 46 + filtered.length * 38))}
        getRowStyle={(p) => (p.data && !p.data.match ? MISMATCH_ROW_STYLE : undefined)}
        getRowId={(p) => `${p.data.style}::${p.data.colour}`}
        overlayNoRowsTemplate="No rows match these filters."
      />
    </>
  );
}
