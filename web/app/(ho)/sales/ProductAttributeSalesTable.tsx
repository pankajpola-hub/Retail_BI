"use client";

import { useMemo, useState } from "react";
import type { ColDef, ICellRendererParams, ValueGetterParams } from "ag-grid-community";
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
import {
  aggregateSalesByAttributes,
  DEFAULT_MRP_BUCKET_SIZE,
  DEFAULT_SALE_ATTRIBUTE_COMBO,
  SALE_ATTRIBUTE_COLUMN_LABELS,
  SALE_ATTRIBUTE_KEYS,
  SALE_ATTRIBUTE_LABELS,
  type SaleAttributeKey,
  type SaleAttributeLineRow,
  type SaleAttributeRow,
} from "@/lib/sales/attributeBreakdown";

const PAGE_KEY = "sales_product_attributes";
const DRAG_MIME = "text/x-sale-attribute";
const INR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const PCT = (n: number | null) => (n === null ? "—" : `${n.toFixed(1)}%`);

type GridRow = SaleAttributeRow | GroupHeaderRow;
function isGroupHeader(row: GridRow | undefined): row is GroupHeaderRow {
  return !!row && "__groupHeader" in row && row.__groupHeader === true;
}

/**
 * Product-attribute breakdown of Sale data — /sales Phase 3 (2026-08-26).
 *
 * Deliberately the same UX as Sale vs Stock Mix's own "View by" combo
 * (app/(replenishment)/movement/SaleStockMixFacetedContent.tsx): a pool of
 * attribute chips, a dashed drop zone holding the active combination in
 * order, native HTML5 drag-and-drop (no library), click-to-add as a
 * keyboard/touch-friendly shortcut for the same thing, and re-ordering by
 * dropping a combo chip onto another. Learn it once, it works in both
 * places.
 *
 * Two deliberate differences from the Mix version:
 *
 *  1. The combo is never empty — Mix falls back to a Style+Color default
 *     grid when you clear it, but this section has no non-attribute default
 *     to fall back to (the calendar-grain view of the same data is already
 *     PeriodSalesFacetedTable, a separate section). Removing the last chip
 *     restores Season + Year rather than leaving a blank card.
 *  2. The aggregated rows get the full FacetFilterBar treatment (search,
 *     facet on the leading attribute, advanced numeric filters, group-by,
 *     saved views) — Mix's attribute grid has none of that. The rows here
 *     are the page's own scope already narrowed to a handful of groups, so
 *     the bar is filtering the ANSWER, not the raw data.
 *
 * Every switch is client-side: the server fetched sale lines once for the
 * page's date range and store scope, and this re-buckets those same lines.
 */
export function ProductAttributeSalesTable({ lines }: { lines: SaleAttributeLineRow[] }) {
  const [combo, setCombo] = useState<SaleAttributeKey[]>(DEFAULT_SALE_ATTRIBUTE_COMBO);
  const [mrpBucketSize, setMrpBucketSize] = useState(DEFAULT_MRP_BUCKET_SIZE);
  const [dragOverZone, setDragOverZone] = useState(false);
  const [state, setState] = useState<FacetFilterState>(emptyFilterState);

  const rows = useMemo(
    () => aggregateSalesByAttributes(lines, combo, mrpBucketSize),
    [lines, combo, mrpBucketSize]
  );

  // Facet on the LEADING attribute only, keyed by the ATTRIBUTE ITSELF
  // (`attr_season`), not by its position.
  //
  // A positional key ("attr0") was the original design, on the theory that
  // FacetFilterBar ignores a filter whose field no longer exists. That holds
  // for advanced CONDITIONS (rowMatchesConditions bails on `if (!f) return
  // true;`) but NOT for facets: "attr0" always exists, so changing the leading
  // attribute — Season+Year → Gender — re-applied the old attribute's stored
  // value ("SS2026") against the new one, producing an impossible chip
  // ("Gender: SS2026") and a silently blank table. Keying by attribute means a
  // changed combo yields a key with no stored selection, which
  // rowMatchesFacets skips via `sel.size === 0` — the quiet degradation the
  // original comment intended.
  const facets = useMemo<FacetDef<SaleAttributeRow>[]>(
    () =>
      combo.length > 0
        ? [
            {
              key: `attr_${combo[0]}`,
              label: SALE_ATTRIBUTE_COLUMN_LABELS[combo[0] as SaleAttributeKey],
              get: (r) => r.values[0] ?? null,
            },
          ]
        : [],
    [combo]
  );

  const advFields = useMemo<AdvField<SaleAttributeRow>[]>(
    () => [
      ...combo.map((attr, i) => ({
        key: `attr${i}`,
        label: SALE_ATTRIBUTE_COLUMN_LABELS[attr],
        get: (r: SaleAttributeRow) => r.values[i] ?? null,
      })),
      { key: "net", label: "Net Sales", get: (r: SaleAttributeRow) => r.net, numeric: true },
      { key: "netSharePct", label: "Share of net %", get: (r: SaleAttributeRow) => r.netSharePct, numeric: true },
      { key: "gross", label: "Gross Sales", get: (r: SaleAttributeRow) => r.gross, numeric: true },
      { key: "discount", label: "Discount", get: (r: SaleAttributeRow) => r.discount, numeric: true },
      { key: "discountPct", label: "Discount %", get: (r: SaleAttributeRow) => r.discountPct, numeric: true },
      { key: "bills", label: "Sale Bills", get: (r: SaleAttributeRow) => r.bills, numeric: true },
      { key: "qty", label: "Qty", get: (r: SaleAttributeRow) => r.qty, numeric: true },
      { key: "atv", label: "ATV", get: (r: SaleAttributeRow) => r.atv, numeric: true },
      { key: "upt", label: "UPT", get: (r: SaleAttributeRow) => r.upt, numeric: true },
      { key: "returnsValue", label: "Returns value", get: (r: SaleAttributeRow) => r.returnsValue, numeric: true },
    ],
    [combo]
  );

  // Group-by only earns its place once the combo has a second attribute —
  // grouping a one-attribute breakdown by that same attribute would put one
  // row under each header, which is noise. Same judgement call Store
  // League's own wrapper makes by passing groupByOptions={[]} outright.
  const groupByOptions = useMemo(
    () =>
      combo.length > 1
        ? [{ key: "attr0", label: SALE_ATTRIBUTE_COLUMN_LABELS[combo[0] as SaleAttributeKey] }]
        : [],
    [combo]
  );
  const groupKeyGetters = useMemo<Record<string, (row: SaleAttributeRow) => string>>(
    () => ({ attr0: (r) => r.values[0] ?? "—" }),
    []
  );

  const filtered = useMemo(() => applyFacetFilter(rows, facets, advFields, state), [rows, facets, advFields, state]);
  const gridRows = useMemo<GridRow[]>(
    () => buildGroupedRows(filtered, state.groupBy, groupKeyGetters),
    [filtered, state.groupBy, groupKeyGetters]
  );

  const poolAttributes = SALE_ATTRIBUTE_KEYS.filter((a) => !combo.includes(a));
  const comboLabel = combo.map((a) => SALE_ATTRIBUTE_LABELS[a]).join(" + ");
  const colCount = combo.length + 8;

  function addToCombo(attr: SaleAttributeKey) {
    setCombo((prev) => (prev.includes(attr) ? prev : [...prev, attr]));
  }
  function removeFromCombo(attr: SaleAttributeKey) {
    // Never leave the section with nothing to show — see the header.
    setCombo((prev) => {
      const next = prev.filter((a) => a !== attr);
      return next.length > 0 ? next : DEFAULT_SALE_ATTRIBUTE_COMBO;
    });
  }
  function reorderCombo(dragged: SaleAttributeKey, targetIndex: number) {
    setCombo((prev) => {
      const without = prev.filter((a) => a !== dragged);
      const clampedIndex = Math.min(targetIndex, without.length);
      return [...without.slice(0, clampedIndex), dragged, ...without.slice(clampedIndex)];
    });
  }

  const columnDefs = useMemo<ColDef<SaleAttributeRow>[]>(() => {
    const attributeCols: ColDef<SaleAttributeRow>[] = combo.map((attr, i) => ({
      headerName: SALE_ATTRIBUTE_COLUMN_LABELS[attr],
      flex: 1,
      sortable: true,
      valueGetter: (p: ValueGetterParams<SaleAttributeRow>) => p.data?.values[i] ?? "",
      ...(i === 0
        ? {
            colSpan: (p: { data?: GridRow }) => (isGroupHeader(p.data) ? colCount : 1),
            cellRenderer: (p: ICellRendererParams<GridRow>) => {
              if (isGroupHeader(p.data)) {
                const g = p.data;
                return (
                  <div
                    className="flex h-full items-center gap-2 bg-surface-2 px-1 text-[12px] font-semibold text-ink-2"
                    style={{ paddingLeft: g.level * 16 }}
                  >
                    <span>{g.label}</span>
                    <span className="font-mono font-normal text-ink-3">({g.count})</span>
                  </div>
                );
              }
              return (p.data as SaleAttributeRow).values[0] ?? "";
            },
          }
        : {}),
    }));

    const right = { cellClass: "text-right font-mono", headerClass: "text-right", sortable: true } as const;

    return [
      ...attributeCols,
      { field: "net", headerName: "Net sales", flex: 0.9, ...right, valueFormatter: (p) => INR(p.value) },
      { field: "netSharePct", headerName: "Share", flex: 0.6, ...right, valueFormatter: (p) => PCT(p.value) },
      { field: "qty", headerName: "Qty", flex: 0.6, ...right, valueFormatter: (p) => Math.round(p.value).toLocaleString("en-IN") },
      { field: "bills", headerName: "Bills", flex: 0.6, ...right, valueFormatter: (p) => Math.round(p.value).toLocaleString("en-IN") },
      { field: "atv", headerName: "ATV", flex: 0.7, ...right, valueFormatter: (p) => (p.value === null ? "—" : INR(p.value)) },
      { field: "upt", headerName: "UPT", flex: 0.6, ...right, valueFormatter: (p) => (p.value === null ? "—" : Number(p.value).toFixed(2)) },
      { field: "discountPct", headerName: "Discount %", flex: 0.7, ...right, valueFormatter: (p) => PCT(p.value) },
      // Math.abs: post-014b1c5 the source net_amount is SIGNED, so a RETURN
      // row's value is negative and returnsValue accumulates a negative total.
      // The column is headed plainly "Returns", so it shows the MAGNITUDE —
      // a bare "₹-1,23,456" under that header reads backwards (more returns
      // looking like a smaller number). The underlying signed value is what
      // nets into `net`/`gross`; only the display is absolute here.
      { field: "returnsValue", headerName: "Returns", flex: 0.7, ...right, valueFormatter: (p) => INR(Math.abs(p.value)) },
    ];
  }, [combo, colCount]);

  return (
    <>
      <div className="mb-3">
        <span className="mb-1.5 block text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
          View by — drag attributes into the box to combine
        </span>

        <div className="flex flex-wrap items-start gap-3">
          {/* Pool — attributes not currently in the combo. Drag one into the
              drop zone, or click it as a shortcut for the same thing. */}
          <div className="flex flex-wrap gap-1.5">
            {poolAttributes.map((attr) => (
              <button
                key={attr}
                type="button"
                draggable
                onDragStart={(e) => e.dataTransfer.setData(DRAG_MIME, attr)}
                onClick={() => addToCombo(attr)}
                className="cursor-grab select-none rounded-full border border-line px-3 py-1 text-[12.5px] font-medium text-ink-3 hover:text-ink-2 active:cursor-grabbing"
                title="Drag into the box, or click to add"
              >
                {SALE_ATTRIBUTE_LABELS[attr]}
              </button>
            ))}
          </div>

          <div className="hidden self-stretch border-l border-line-soft sm:block" />

          {/* Drop zone — the active combo, in order. */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOverZone(true);
            }}
            onDragLeave={() => setDragOverZone(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOverZone(false);
              const attr = e.dataTransfer.getData(DRAG_MIME) as SaleAttributeKey;
              if (attr) addToCombo(attr);
            }}
            className={`flex min-h-[34px] min-w-[220px] flex-1 flex-wrap items-center gap-1.5 rounded-lg border-2 border-dashed px-3 py-1.5 ${
              dragOverZone ? "border-accent bg-accent-soft" : "border-line-soft"
            }`}
          >
            {combo.map((attr, i) => (
              <div
                key={attr}
                draggable
                onDragStart={(e) => e.dataTransfer.setData(DRAG_MIME, attr)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const dragged = e.dataTransfer.getData(DRAG_MIME) as SaleAttributeKey;
                  if (dragged) reorderCombo(dragged, i);
                }}
                className="flex cursor-grab select-none items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1 text-[12.5px] font-semibold text-accent-ink active:cursor-grabbing"
              >
                {i > 0 && <span className="text-ink-3">+</span>}
                {SALE_ATTRIBUTE_LABELS[attr]}
                <button
                  type="button"
                  onClick={() => removeFromCombo(attr)}
                  className="ml-0.5 text-accent-ink hover:text-crit"
                  aria-label={`Remove ${SALE_ATTRIBUTE_LABELS[attr]}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          {combo.includes("mrp") && (
            <label className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
              Bucket size ₹
              <input
                type="number"
                min={1}
                step={50}
                value={mrpBucketSize}
                onChange={(e) => setMrpBucketSize(Math.max(1, Number(e.target.value) || DEFAULT_MRP_BUCKET_SIZE))}
                className="w-20 border border-line-soft px-2 py-1 text-[12.5px]"
              />
            </label>
          )}
        </div>
      </div>

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
        {filtered.length === rows.length
          ? `${filtered.length} ${comboLabel.toLowerCase()} groups`
          : `${filtered.length} of ${rows.length} ${comboLabel.toLowerCase()} groups`}
      </div>
      <DataGrid<GridRow>
        // Full remount whenever the combo changes column COUNT/order. The
        // attribute columns have no `field`, only a positional valueGetter,
        // and AG Grid's column-state reconciliation leaves stale/blank cells
        // across that kind of shape change — the same reason (and the same
        // fix) AttributeMixGrid.tsx documents for its own combo key.
        key={combo.join("+")}
        animateRows={false}
        rowData={gridRows}
        columnDefs={columnDefs as unknown as ColDef<GridRow>[]}
        heightPx={Math.min(640, Math.max(160, 46 + gridRows.length * 38))}
        getRowId={(p) => (isGroupHeader(p.data) ? p.data.id : (p.data as SaleAttributeRow).values.join("|"))}
        overlayNoRowsTemplate={`No ${comboLabel.toLowerCase()} groups match these filters.`}
      />
    </>
  );
}
