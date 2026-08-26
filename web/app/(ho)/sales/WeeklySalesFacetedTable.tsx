"use client";

import { useMemo, useState } from "react";
import { TrendingUp, TrendingDown } from "lucide-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { DataGrid } from "@/components/ui/DataGrid";
import {
  FacetFilterBar,
  applyFacetFilter,
  buildGroupedRows,
  emptyFilterState,
  type FacetDef,
  type AdvField,
  type FacetFilterState,
  type GroupHeaderRow,
} from "@/components/ui/FacetFilterBar";
import type { WeekRow } from "@/lib/sales/aggregate";

const PAGE_KEY = "sales_weekly";
const INR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

export type WeeklyFacetedRow = WeekRow & {
  storeId: string;
  storeName: string;
  rangeLabel: string;
  discountPct: number | null;
  atv: number | null;
};

type GridRow = WeeklyFacetedRow | GroupHeaderRow;
function isGroupHeader(row: GridRow | undefined): row is GroupHeaderRow {
  return !!row && "__groupHeader" in row && row.__groupHeader === true;
}

const COL_COUNT = 12;

/** WoW% cell — a trend glyph alongside the color, not color alone (2026-08-26 polish pass). */
function WowCell({ value }: { value: number | null }) {
  if (value === null) return <span className="font-mono text-ink-3">—</span>;
  const up = value >= 0;
  return (
    <span className={`inline-flex items-center gap-1 font-mono ${up ? "text-good" : "text-crit"}`}>
      {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      {up ? "+" : ""}
      {value.toFixed(1)}%
    </span>
  );
}

/**
 * Phase 1 polish pass (2026-08-26) — Week-wise sales table ported off a
 * hand-rolled per-store <table> loop onto the same FacetFilterBar +
 * DataGrid engine Replenishment/Sale-Stock-Mix/Network already use. One
 * flat row per (store, retail-week) — a store's own table and the group-by
 * dropdown are now the SAME mechanism (group by Store) instead of two
 * separate concepts, which is also what lets "Network total" just be
 * another advanced-filter-visible aggregate rather than a special case.
 */
export function WeeklySalesFacetedTable({ rows }: { rows: WeeklyFacetedRow[] }) {
  const [state, setState] = useState<FacetFilterState>(emptyFilterState);

  const facets = useMemo<FacetDef<WeeklyFacetedRow>[]>(() => [{ key: "store", label: "Store", get: (r) => r.storeName }], []);

  const advFields = useMemo<AdvField<WeeklyFacetedRow>[]>(
    () => [
      { key: "store", label: "Store", get: (r) => r.storeName },
      { key: "retailWeek", label: "Retail Week", get: (r) => r.retailWeek, numeric: true },
      { key: "net", label: "Net Sales", get: (r) => r.net, numeric: true },
      { key: "netChangePct", label: "Net WoW %", get: (r) => r.netChangePct, numeric: true },
      { key: "gross", label: "Gross Sales", get: (r) => r.gross, numeric: true },
      { key: "discount", label: "Discount", get: (r) => r.discount, numeric: true },
      { key: "discountPct", label: "Discount %", get: (r) => r.discountPct, numeric: true },
      { key: "bills", label: "Sale Bills", get: (r) => r.bills, numeric: true },
      { key: "qty", label: "Qty", get: (r) => r.qty, numeric: true },
      { key: "qtyChangePct", label: "Qty WoW %", get: (r) => r.qtyChangePct, numeric: true },
      { key: "atv", label: "ATV", get: (r) => r.atv, numeric: true },
      { key: "isCompleteWeek", label: "Complete week", get: (r) => (r.isCompleteWeek ? "Yes" : "No") },
    ],
    []
  );

  const groupByOptions = useMemo(() => [{ key: "store", label: "Store" }], []);
  const groupKeyGetters = useMemo<Record<string, (row: WeeklyFacetedRow) => string>>(() => ({ store: (r) => r.storeName }), []);

  const filtered = useMemo(() => applyFacetFilter(rows, facets, advFields, state), [rows, facets, advFields, state]);
  const gridRows = useMemo<GridRow[]>(
    () => buildGroupedRows(filtered, state.groupBy, groupKeyGetters),
    [filtered, state.groupBy, groupKeyGetters]
  );

  const weekLabel = (n: number) => `RW${String(n).padStart(2, "0")}`;

  const columnDefs = useMemo<ColDef<WeeklyFacetedRow>[]>(
    () => [
      {
        field: "storeName",
        headerName: "Store",
        flex: 1.1,
        sortable: true,
        colSpan: (p: { data?: GridRow }) => (isGroupHeader(p.data) ? COL_COUNT : 1),
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
          return (p.data as WeeklyFacetedRow).storeName;
        },
      },
      { field: "retailWeek", headerName: "Week", flex: 0.6, sortable: true, valueFormatter: (p) => weekLabel(p.value) },
      { field: "rangeLabel", headerName: "Range", flex: 1, sortable: true, cellClass: "text-ink-3" },
      { field: "net", headerName: "Net sales", flex: 0.9, sortable: true, cellClass: "text-right font-mono", headerClass: "text-right", valueFormatter: (p) => INR(p.value) },
      {
        field: "netChangePct",
        headerName: "Net WoW",
        flex: 0.8,
        sortable: true,
        cellClass: "text-right",
        headerClass: "text-right",
        cellRenderer: (p: ICellRendererParams<WeeklyFacetedRow, number | null>) => <WowCell value={p.value ?? null} />,
      },
      { field: "gross", headerName: "Gross", flex: 0.9, sortable: true, cellClass: "text-right font-mono", headerClass: "text-right", valueFormatter: (p) => INR(p.value) },
      { field: "discountPct", headerName: "Discount %", flex: 0.8, sortable: true, cellClass: "text-right font-mono", headerClass: "text-right", valueFormatter: (p) => (p.value === null ? "—" : `${p.value.toFixed(1)}%`) },
      { field: "bills", headerName: "Bills", flex: 0.6, sortable: true, cellClass: "text-right font-mono", headerClass: "text-right" },
      { field: "qty", headerName: "Qty", flex: 0.6, sortable: true, cellClass: "text-right font-mono", headerClass: "text-right" },
      {
        field: "qtyChangePct",
        headerName: "Qty WoW",
        flex: 0.8,
        sortable: true,
        cellClass: "text-right",
        headerClass: "text-right",
        cellRenderer: (p: ICellRendererParams<WeeklyFacetedRow, number | null>) => <WowCell value={p.value ?? null} />,
      },
      { field: "atv", headerName: "ATV", flex: 0.8, sortable: true, cellClass: "text-right font-mono", headerClass: "text-right", valueFormatter: (p) => (p.value === null ? "—" : INR(p.value)) },
      {
        field: "isCompleteWeek",
        headerName: "Complete?",
        flex: 0.8,
        sortable: true,
        cellClass: "text-ink-3",
        valueFormatter: (p) => (p.value ? "Yes" : "No"),
      },
    ],
    []
  );

  return (
    <>
      <FacetFilterBar
        pageKey={PAGE_KEY}
        rows={rows}
        facets={facets}
        advFields={advFields}
        groupByOptions={groupByOptions}
        state={state}
        onChange={setState}
      />
      <div className="mb-2 text-[12px] text-ink-3">
        {filtered.length === rows.length ? `${filtered.length} rows` : `${filtered.length} of ${rows.length} rows`}
      </div>
      <DataGrid<GridRow>
        animateRows={false}
        rowData={gridRows}
        columnDefs={columnDefs as unknown as ColDef<GridRow>[]}
        heightPx={Math.min(560, Math.max(160, 46 + gridRows.length * 38))}
        getRowId={(p) => (isGroupHeader(p.data) ? p.data.id : `${(p.data as WeeklyFacetedRow).storeId}|${(p.data as WeeklyFacetedRow).weekStart}`)}
        overlayNoRowsTemplate="No weeks match these filters."
      />
    </>
  );
}
