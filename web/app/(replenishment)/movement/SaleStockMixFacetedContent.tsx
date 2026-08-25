"use client";

import { useMemo, useState } from "react";
import {
  FacetFilterBar,
  applyFacetFilter,
  buildGroupedRows,
  emptyFilterState,
  type FacetDef,
  type AdvField,
  type FacetFilterState,
} from "@/components/ui/FacetFilterBar";
import { SaleStockMixGrid } from "../sale-stock-mix/SaleStockMixGrid";
import { AttributeMixGrid } from "./AttributeMixGrid";
import type { MixRow, MixItemRow } from "@/lib/replenishment/mix";
import { aggregateMixByAttributes, ATTRIBUTE_LABELS, ATTRIBUTE_KEYS, type AttributeKey } from "@/lib/replenishment/mixAttributes";

const PAGE_KEY = "movement_mix";
const DEFAULT_MRP_BUCKET_SIZE = 500;

// A custom MIME type, not "text/plain" — keeps this drag payload from being
// accidentally accepted by an unrelated drop target elsewhere on the page
// (e.g. a text input), and vice versa.
const DRAG_MIME = "application/x-mix-attribute";

/**
 * Phase 1 of the faceted-filtering system, second page (see
 * ReplenishmentFacetedContent.tsx for the first). Unlike Replenishment,
 * `store` here is NOT a pure display filter — computeSaleStockMix
 * genuinely aggregates at the store scope (or network-wide when storeId is
 * empty), so a per-store row breakdown doesn't exist to facet over
 * client-side without a bigger backend change. Store and the sales-period
 * window stay real server params in page.tsx; only style/color/status
 * (already plain post-filters on the fetched rows before this) move here.
 *
 * "View by" combo bar (2026-08-25) — a second, independent axis on top of
 * that: Style+Color stays the default (exactly today's FacetFilterBar + AG
 * Grid with search/advanced-filter/group-by/saved-views). Dragging one or
 * more attribute chips (Color / Size / Size Group / Gender / Season+Year /
 * MRP Range) into the drop zone below re-aggregates the same underlying
 * item_code-level rows (`itemRows`, from mix.ts) by that COMBINATION —
 * entirely client-side, no new server fetch. Native HTML5 drag-and-drop
 * (no library): the pool holds attributes not yet in the combo, the combo
 * bar holds the active ones in order and accepts re-ordering by dragging a
 * combo chip onto another one. Clearing the combo (the × on each chip, or
 * dragging every chip back out) returns to the Style+Color default.
 */
export function SaleStockMixFacetedContent({
  rows,
  itemRows,
  totalSales,
  totalStock,
}: {
  rows: MixRow[];
  itemRows: MixItemRow[];
  totalSales: number;
  totalStock: number;
}) {
  const [combo, setCombo] = useState<AttributeKey[]>([]);
  const [mrpBucketSize, setMrpBucketSize] = useState(DEFAULT_MRP_BUCKET_SIZE);
  const [dragOverZone, setDragOverZone] = useState(false);
  const [state, setState] = useState<FacetFilterState>(emptyFilterState);

  const facets = useMemo<FacetDef<MixRow>[]>(() => [{ key: "status", label: "Status", get: (r) => r.status }], []);

  const advFields = useMemo<AdvField<MixRow>[]>(
    () => [
      { key: "styleNo", label: "Style No.", get: (r) => r.styleNo },
      { key: "color", label: "Color", get: (r) => r.color },
      { key: "sales", label: "Sales", get: (r) => r.sales, numeric: true },
      { key: "saleMixPct", label: "Sale Mix %", get: (r) => r.saleMixPct, numeric: true },
      { key: "soh", label: "Store SOH", get: (r) => r.soh, numeric: true },
      { key: "stockMixPct", label: "Stock Mix %", get: (r) => r.stockMixPct, numeric: true },
      { key: "mixGapPts", label: "Mix Gap (pp)", get: (r) => r.mixGapPts, numeric: true },
    ],
    []
  );

  const groupByOptions = useMemo(
    () => [
      { key: "styleNo", label: "Style No." },
      { key: "color", label: "Color" },
      { key: "status", label: "Status" },
    ],
    []
  );
  const groupKeyGetters = useMemo<Record<string, (row: MixRow) => string>>(
    () => ({
      styleNo: (r) => r.styleNo,
      color: (r) => r.color,
      status: (r) => r.status,
    }),
    []
  );

  const filtered = useMemo(() => applyFacetFilter(rows, facets, advFields, state), [rows, facets, advFields, state]);
  const gridRows = useMemo(() => buildGroupedRows(filtered, state.groupBy, groupKeyGetters), [filtered, state.groupBy, groupKeyGetters]);

  const attributeRows = useMemo(
    () => aggregateMixByAttributes(itemRows, combo, totalSales, totalStock, mrpBucketSize),
    [itemRows, combo, totalSales, totalStock, mrpBucketSize]
  );

  const poolAttributes = ATTRIBUTE_KEYS.filter((a) => !combo.includes(a));

  function addToCombo(attr: AttributeKey) {
    setCombo((prev) => (prev.includes(attr) ? prev : [...prev, attr]));
  }
  function removeFromCombo(attr: AttributeKey) {
    setCombo((prev) => prev.filter((a) => a !== attr));
  }
  function reorderCombo(dragged: AttributeKey, targetIndex: number) {
    setCombo((prev) => {
      const without = prev.filter((a) => a !== dragged);
      const clampedIndex = Math.min(targetIndex, without.length);
      return [...without.slice(0, clampedIndex), dragged, ...without.slice(clampedIndex)];
    });
  }

  return (
    <>
      <div className="mb-3">
        <span className="mb-1.5 block text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
          View by — drag attributes into the box to combine
        </span>

        <div className="flex flex-wrap items-start gap-3">
          {/* Pool — attributes not currently in the combo. Drag one into
              the drop zone, or click it as a shortcut for the same thing. */}
          <div className="flex flex-wrap gap-1.5">
            {poolAttributes.map((attr) => (
              <div
                key={attr}
                draggable
                onDragStart={(e) => e.dataTransfer.setData(DRAG_MIME, attr)}
                onClick={() => addToCombo(attr)}
                className="cursor-grab select-none rounded-full border border-line px-3 py-1 text-[12.5px] font-medium text-ink-3 hover:text-ink-2 active:cursor-grabbing"
                title="Drag into the box, or click to add"
              >
                {ATTRIBUTE_LABELS[attr]}
              </div>
            ))}
          </div>

          <div className="hidden self-stretch border-l border-line-soft sm:block" />

          {/* Drop zone — the active combo. Empty = Style+Color default. */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOverZone(true);
            }}
            onDragLeave={() => setDragOverZone(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOverZone(false);
              const attr = e.dataTransfer.getData(DRAG_MIME) as AttributeKey;
              if (attr) addToCombo(attr);
            }}
            className={`flex min-h-[34px] min-w-[220px] flex-1 flex-wrap items-center gap-1.5 rounded-lg border-2 border-dashed px-3 py-1.5 ${
              dragOverZone ? "border-accent bg-accent-soft" : "border-line-soft"
            }`}
          >
            {combo.length === 0 ? (
              <span className="text-[12.5px] text-ink-3">Style + Color (default) — drag a chip here to combine views</span>
            ) : (
              combo.map((attr, i) => (
                <div
                  key={attr}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData(DRAG_MIME, attr)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const dragged = e.dataTransfer.getData(DRAG_MIME) as AttributeKey;
                    if (dragged) reorderCombo(dragged, i);
                  }}
                  className="flex cursor-grab select-none items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1 text-[12.5px] font-semibold text-accent-ink active:cursor-grabbing"
                >
                  {i > 0 && <span className="text-ink-3">+</span>}
                  {ATTRIBUTE_LABELS[attr]}
                  <button
                    type="button"
                    onClick={() => removeFromCombo(attr)}
                    className="ml-0.5 text-accent-ink hover:text-crit"
                    aria-label={`Remove ${ATTRIBUTE_LABELS[attr]}`}
                  >
                    ×
                  </button>
                </div>
              ))
            )}
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

      {combo.length === 0 ? (
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
          <SaleStockMixGrid rows={gridRows} />
        </>
      ) : (
        <>
          <div className="mb-2 text-[12px] text-ink-3">
            {attributeRows.length} {combo.map((a) => ATTRIBUTE_LABELS[a]).join(" + ").toLowerCase()} groups
          </div>
          <AttributeMixGrid rows={attributeRows} attributes={combo} />
        </>
      )}
    </>
  );
}
