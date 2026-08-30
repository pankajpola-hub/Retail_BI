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

/**
 * Big executive-summary tile. Optionally a toggle for the "Go-Live Status"
 * facet (clicking Live/Can Go Live/Not Live sets that one facet value on or
 * off) - the numbers ARE the drill-down, so a boss scanning this doesn't
 * need to separately learn the facet bar underneath to act on what they see.
 */
function KpiTile({
  num,
  label,
  tone,
  active,
  onClick,
}: {
  num: number | string;
  label: string;
  tone?: "good" | "warn" | "crit";
  active?: boolean;
  onClick?: () => void;
}) {
  const toneClass = tone === "good" ? "text-good" : tone === "warn" ? "text-warn" : tone === "crit" ? "text-crit" : "text-ink";
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={`rounded-lg border px-5 py-3.5 text-left transition-colors ${
        active ? "border-accent bg-accent-soft" : "border-line bg-surface hover:bg-surface-2"
      } ${onClick ? "cursor-pointer" : ""}`}
    >
      <div className={`text-2xl font-serif ${toneClass}`}>{num}</div>
      <div className="mt-0.5 text-[11.5px] font-medium uppercase tracking-wide text-ink-3">{label}</div>
    </Comp>
  );
}

/**
 * WH stock vs Shopify SOH, per style/colour - ported from the Shopify
 * image-uploader project's Stock Status page
 * (D:\Py\Shopify image uploader\server\static\index.html, the "Stock
 * Status (WH vs Shopify)" section), same FacetFilterBar engine this app
 * already shares with every other faceted table here.
 *
 * The KPI row up top is the "boss view" - Live / Can Go Live / Not Live /
 * mismatches, each clickable straight into the filtered detail table below
 * it, so a five-second glance answers "what's live, what isn't, and what's
 * sitting in the warehouse ready to go live" without reading the grid.
 */
export function StockStatusFacetedTable({ rows }: { rows: StockStatusRow[] }) {
  const [state, setState] = useState<FacetFilterState>(emptyFilterState);

  const facets = useMemo<FacetDef<StockStatusRow>[]>(
    () => [
      { key: "goLiveStatus", label: "Go-Live Status", get: (r) => r.goLiveStatus },
      { key: "colour", label: "Colour", get: (r) => r.colour },
      { key: "status", label: "Shopify Status", get: (r) => r.status || "Unknown" },
      { key: "match", label: "Match", get: (r) => (r.match ? "Match" : "Mismatch") },
      { key: "onShopify", label: "On Shopify", get: (r) => (r.onShopify ? "Yes" : "No") },
      { key: "whHasData", label: "WH Data", get: (r) => (r.whHasData ? "Has WH data" : "No WH data") },
      // Item-master attributes (raw_logic.item_master, already joined onto
      // vw_stock_with_scheme) - same attribute set lib/replenishment/mix.ts's
      // attribute-wise views (Color/Size/Gender/Season/MRP) offer.
      { key: "season", label: "Season", get: (r) => r.season },
      { key: "gender", label: "Gender", get: (r) => r.gender },
      { key: "sizeGroup", label: "Size Group", get: (r) => r.sizeGroup },
      { key: "subcategory", label: "Subcategory", get: (r) => r.subcategory },
      { key: "marketSegment", label: "Market Segment", get: (r) => r.marketSegment },
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
      { key: "season", label: "Season", get: (r) => r.season },
      { key: "gender", label: "Gender", get: (r) => r.gender },
      { key: "sizeGroup", label: "Size Group", get: (r) => r.sizeGroup },
      { key: "subcategory", label: "Subcategory", get: (r) => r.subcategory },
      { key: "marketSegment", label: "Market Segment", get: (r) => r.marketSegment },
      { key: "mrp", label: "MRP", get: (r) => r.mrp, numeric: true },
    ],
    []
  );

  const filtered = useMemo(() => applyFacetFilter(rows, facets, advFields, state), [rows, facets, advFields, state]);

  // Counted over ALL rows (not `filtered`) - the KPI row is the fixed
  // top-level summary the facet bar drills down FROM, so it shouldn't
  // shrink just because someone is mid-filter on something else. Each tile
  // toggles the one facet value it represents, same click-to-filter the
  // facet panel itself offers.
  const liveCount = useMemo(() => rows.filter((r) => r.goLiveStatus === "Live").length, [rows]);
  const canGoLiveCount = useMemo(() => rows.filter((r) => r.goLiveStatus === "Can Go Live").length, [rows]);
  const notLiveCount = useMemo(() => rows.filter((r) => r.goLiveStatus === "Not Live").length, [rows]);
  const mismatchCount = useMemo(() => rows.filter((r) => !r.match).length, [rows]);
  const totalWh = useMemo(() => rows.reduce((s, r) => s + (r.whHasData ? r.whStock : 0), 0), [rows]);
  const totalShopify = useMemo(() => rows.reduce((s, r) => s + (r.shopifyHasData ? r.shopifySoh : 0), 0), [rows]);

  function toggleGoLiveStatus(value: string) {
    const cur = new Set(state.facets.goLiveStatus ?? []);
    if (cur.has(value)) cur.delete(value);
    else {
      cur.clear(); // one status at a time from the KPI row - a multi-select is the facet panel's job, not the headline tiles'
      cur.add(value);
    }
    setState({ ...state, facets: { ...state.facets, goLiveStatus: [...cur] } });
  }
  const activeGoLive = new Set(state.facets.goLiveStatus ?? []);

  const columnDefs = useMemo<ColDef<StockStatusRow>[]>(
    () => [
      { field: "style", headerName: "Style", flex: 0.7, sortable: true, cellClass: "font-semibold" },
      { field: "title", headerName: "Product Title", flex: 1.5, sortable: true },
      { field: "colour", headerName: "Colour", flex: 0.8, sortable: true },
      {
        field: "goLiveStatus",
        headerName: "Go-Live Status",
        flex: 0.9,
        sortable: true,
        cellClass: (p: CellClassParams<StockStatusRow, string>) =>
          p.value === "Live" ? "text-good font-semibold" : p.value === "Can Go Live" ? "text-warn font-semibold" : "text-ink-3",
      },
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
      { field: "season", headerName: "Season", flex: 0.7, sortable: true },
      { field: "gender", headerName: "Gender", flex: 0.6, sortable: true },
      { field: "sizeGroup", headerName: "Size Group", flex: 0.7, sortable: true },
      { field: "subcategory", headerName: "Subcategory", flex: 0.8, sortable: true },
      { field: "marketSegment", headerName: "Market Segment", flex: 0.8, sortable: true },
      {
        field: "mrp",
        headerName: "MRP",
        flex: 0.6,
        sortable: true,
        cellClass: "text-right font-mono",
        headerClass: "text-right",
        valueFormatter: (p: ValueFormatterParams<StockStatusRow, number | null>) => (p.value == null ? "—" : `₹${p.value}`),
      },
    ],
    []
  );

  return (
    <>
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <KpiTile num={liveCount} label="Live on Shopify" tone="good" active={activeGoLive.has("Live")} onClick={() => toggleGoLiveStatus("Live")} />
        <KpiTile
          num={canGoLiveCount}
          label="Can go live now"
          tone="warn"
          active={activeGoLive.has("Can Go Live")}
          onClick={() => toggleGoLiveStatus("Can Go Live")}
        />
        <KpiTile num={notLiveCount} label="Not live" active={activeGoLive.has("Not Live")} onClick={() => toggleGoLiveStatus("Not Live")} />
        <KpiTile num={mismatchCount} label="Stock mismatches" tone={mismatchCount > 0 ? "crit" : undefined} />
        <KpiTile num={totalWh.toLocaleString("en-IN")} label="Total WH stock" />
        <KpiTile num={totalShopify.toLocaleString("en-IN")} label="Total Shopify SOH" />
      </div>
      <p className="mb-4 text-[11.5px] text-ink-3">
        Shopify is the only live channel wired up here today - Myntra/Ajio/other marketplace inventory isn&apos;t
        fed into this comparison yet (their sales are tracked on the Ecomm page, but not live stock).
      </p>

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
