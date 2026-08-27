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
import type { PeriodRow } from "@/lib/sales/aggregate";

const PAGE_KEY = "sales_period";
const INR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

export type PeriodFacetedRow = PeriodRow & { storeId: string; storeName: string };

type GridRow = PeriodFacetedRow | GroupHeaderRow;
function isGroupHeader(row: GridRow | undefined): row is GroupHeaderRow {
  return !!row && "__groupHeader" in row && row.__groupHeader === true;
}

const COL_COUNT = 11;

/** Synthetic all-stores bucket appended by page.tsx's buildRows(). */
const NETWORK_STORE_ID = "__network__";
const NETWORK_LABEL = "Network total";

function isNetworkRow(row: GridRow | undefined): boolean {
  if (!row) return false;
  return isGroupHeader(row) ? row.label === NETWORK_LABEL : row.storeId === NETWORK_STORE_ID;
}

/**
 * buildGroupedRows() sorts group buckets alphabetically, which would drop the
 * synthetic "Network total" bucket into the middle of the store list. It's a
 * summary, not a peer store, so its header + rows are hoisted to the bottom.
 */
function networkGroupLast(rows: GridRow[]): GridRow[] {
  const rest: GridRow[] = [];
  const network: GridRow[] = [];
  let inNetworkGroup = false;
  for (const row of rows) {
    if (isGroupHeader(row)) inNetworkGroup = row.label === NETWORK_LABEL;
    (inNetworkGroup ? network : rest).push(row);
  }
  return network.length > 0 ? [...rest, ...network] : rows;
}

type Grain = "daily" | "weekly" | "monthly" | "yearly";
const GRAIN_LABELS: Record<Grain, string> = { daily: "Daily", weekly: "Weekly", monthly: "Monthly", yearly: "Yearly" };
const GRAINS: Grain[] = ["daily", "weekly", "monthly", "yearly"];

/** WoW/DoD/MoM/YoY% cell — trend glyph alongside color, not color alone. */
function ChangeCell({ value }: { value: number | null }) {
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
 * Date-grain toggle (2026-08-26, Phase 2) — same table, four pre-computed
 * row-sets (Daily/Weekly/Monthly/Yearly, all built server-side in
 * EboDetailSection via lib/sales/aggregate.ts's buildDailyPeriodSeries/
 * buildWeekSeries/buildMonthlyPeriodSeries/buildYearlyPeriodSeries) switched
 * client-side — no re-fetch on toggle, all four are cheap pre-aggregated
 * views already fetched once per page render. "Network total" is one more
 * store-like bucket in whichever grain's row-set is active, same as before.
 */
export function PeriodSalesFacetedTable({
  daily,
  weekly,
  monthly,
  yearly,
}: {
  daily: PeriodFacetedRow[];
  weekly: PeriodFacetedRow[];
  monthly: PeriodFacetedRow[];
  yearly: PeriodFacetedRow[];
}) {
  const [grain, setGrain] = useState<Grain>("weekly");
  // Grouped by Store by default (2026-08-27): a flat list ran one store's
  // period rows straight into the next with no visual break. The user can
  // still drop or add group-by keys from the filter bar.
  const [state, setState] = useState<FacetFilterState>(() => ({ ...emptyFilterState(), groupBy: ["store"] }));

  const rows = grain === "daily" ? daily : grain === "weekly" ? weekly : grain === "monthly" ? monthly : yearly;

  const facets = useMemo<FacetDef<PeriodFacetedRow>[]>(() => [{ key: "store", label: "Store", get: (r) => r.storeName }], []);

  const advFields = useMemo<AdvField<PeriodFacetedRow>[]>(
    () => [
      { key: "store", label: "Store", get: (r) => r.storeName },
      { key: "period", label: "Period", get: (r) => r.periodLabel },
      { key: "net", label: "Net Sales", get: (r) => r.net, numeric: true },
      { key: "netChangePct", label: "Net change %", get: (r) => r.netChangePct, numeric: true },
      { key: "gross", label: "Gross Sales", get: (r) => r.gross, numeric: true },
      { key: "discount", label: "Discount", get: (r) => r.discount, numeric: true },
      { key: "discountPct", label: "Discount %", get: (r) => r.discountPct, numeric: true },
      { key: "bills", label: "Sale Bills", get: (r) => r.bills, numeric: true },
      { key: "qty", label: "Qty", get: (r) => r.qty, numeric: true },
      { key: "qtyChangePct", label: "Qty change %", get: (r) => r.qtyChangePct, numeric: true },
      { key: "atv", label: "ATV", get: (r) => r.atv, numeric: true },
      { key: "isComplete", label: "Period complete?", get: (r) => (r.isComplete ? "Yes" : "No") },
    ],
    []
  );

  const groupByOptions = useMemo(() => [{ key: "store", label: "Store" }], []);
  const groupKeyGetters = useMemo<Record<string, (row: PeriodFacetedRow) => string>>(() => ({ store: (r) => r.storeName }), []);

  const filtered = useMemo(() => applyFacetFilter(rows, facets, advFields, state), [rows, facets, advFields, state]);
  const gridRows = useMemo<GridRow[]>(
    () => networkGroupLast(buildGroupedRows(filtered, state.groupBy, groupKeyGetters)),
    [filtered, state.groupBy, groupKeyGetters]
  );

  const columnDefs = useMemo<ColDef<PeriodFacetedRow>[]>(
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
            // Network total's banner is a summary, not a peer store — heavier
            // weight + a hard rule above it separate it from the store blocks.
            const network = g.label === NETWORK_LABEL;
            return (
              <div
                className={`flex h-full items-center gap-2 bg-surface-2 px-1 text-[12px] ${
                  network ? "border-t-2 border-line font-bold text-ink" : "font-semibold text-ink-2"
                }`}
                style={{ paddingLeft: g.level * 16 }}
              >
                <span>{g.label}</span>
                <span className="font-mono font-normal text-ink-3">({g.count})</span>
              </div>
            );
          }
          return (p.data as PeriodFacetedRow).storeName;
        },
      },
      { field: "periodLabel", headerName: "Period", flex: 0.9, sortable: true, cellClass: "font-semibold" },
      { field: "rangeLabel", headerName: "Range", flex: 1, sortable: true, cellClass: "text-ink-3" },
      { field: "net", headerName: "Net sales", flex: 0.9, sortable: true, cellClass: "text-right font-mono", headerClass: "text-right", valueFormatter: (p) => INR(p.value) },
      {
        field: "netChangePct",
        headerName: "Net change",
        flex: 0.8,
        sortable: true,
        cellClass: "text-right",
        headerClass: "text-right",
        cellRenderer: (p: ICellRendererParams<PeriodFacetedRow, number | null>) => <ChangeCell value={p.value ?? null} />,
      },
      { field: "gross", headerName: "Gross", flex: 0.9, sortable: true, cellClass: "text-right font-mono", headerClass: "text-right", valueFormatter: (p) => INR(p.value) },
      { field: "discountPct", headerName: "Discount %", flex: 0.8, sortable: true, cellClass: "text-right font-mono", headerClass: "text-right", valueFormatter: (p) => (p.value === null ? "—" : `${p.value.toFixed(1)}%`) },
      { field: "bills", headerName: "Bills", flex: 0.6, sortable: true, cellClass: "text-right font-mono", headerClass: "text-right" },
      { field: "qty", headerName: "Qty", flex: 0.6, sortable: true, cellClass: "text-right font-mono", headerClass: "text-right" },
      {
        field: "qtyChangePct",
        headerName: "Qty change",
        flex: 0.8,
        sortable: true,
        cellClass: "text-right",
        headerClass: "text-right",
        cellRenderer: (p: ICellRendererParams<PeriodFacetedRow, number | null>) => <ChangeCell value={p.value ?? null} />,
      },
      { field: "atv", headerName: "ATV", flex: 0.8, sortable: true, cellClass: "text-right font-mono", headerClass: "text-right", valueFormatter: (p) => (p.value === null ? "—" : INR(p.value)) },
    ],
    []
  );

  return (
    <>
      <div className="mb-3 flex gap-1.5">
        {GRAINS.map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => setGrain(g)}
            className={`rounded-full border px-3 py-1 text-[12px] font-medium ${
              grain === g ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-ink-3 hover:text-ink-2"
            }`}
          >
            {GRAIN_LABELS[g]}
          </button>
        ))}
      </div>

      <FacetFilterBar
        pageKey={`${PAGE_KEY}_${grain}`}
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
        // Full remount on grain change — rows carry a completely different
        // period axis (day vs week vs month vs year), same "shape changed,
        // force a redraw" reasoning AttributeReplenishmentGrid.tsx already
        // documents for its own combo-change key.
        key={grain}
        animateRows={false}
        rowData={gridRows}
        columnDefs={columnDefs as unknown as ColDef<GridRow>[]}
        heightPx={Math.min(560, Math.max(160, 46 + gridRows.length * 38))}
        // Network total's data rows read as a summary block, not another store:
        // tinted + semibold. Inline (not a Tailwind class) because AG Grid's own
        // .ag-row background/`font` rules otherwise win the cascade.
        getRowStyle={(p) =>
          isNetworkRow(p.data) && !isGroupHeader(p.data)
            ? { background: "var(--surface-2)", fontWeight: 600 }
            : undefined
        }
        getRowId={(p) => (isGroupHeader(p.data) ? p.data.id : `${(p.data as PeriodFacetedRow).storeId}|${(p.data as PeriodFacetedRow).periodKey}`)}
        overlayNoRowsTemplate="No periods match these filters."
      />
    </>
  );
}
