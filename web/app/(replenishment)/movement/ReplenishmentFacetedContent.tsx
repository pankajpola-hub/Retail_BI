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
import { ReplenishmentGrid } from "../replenishment/ReplenishmentGrid";
import { AttributeReplenishmentGrid } from "./AttributeReplenishmentGrid";
import type { Row, ReplItemRow } from "@/lib/replenishment/compute";
import { aggregateReplenishmentByAttributes, ATTRIBUTE_LABELS, ATTRIBUTE_KEYS, type AttributeKey } from "@/lib/replenishment/replAttributes";

const PAGE_KEY = "movement_replenishment";
const DEFAULT_MRP_BUCKET_SIZE = 500;

// A custom MIME type (not "text/plain") — same reasoning as
// SaleStockMixFacetedContent.tsx's own DRAG_MIME: keeps this drag payload
// from being accidentally accepted by an unrelated drop target elsewhere on
// the page, and vice versa. Deliberately a DIFFERENT string from the Mix
// tab's own DRAG_MIME even though the payload shape is identical, so a chip
// dragged from one tab's combo bar can never be dropped onto the other's.
const DRAG_MIME = "application/x-replenishment-attribute";

/**
 * Phase 1 of the faceted-filtering system (see the plan file) — the
 * Replenishment tab's instant, client-side search/facet/chip/group-by/
 * saved-view layer, wired to the full un-paginated row set the server
 * still computes once (computeReplenishmentRows, unchanged). Everything
 * below is a pure client-side derivation of `rows`; no server round-trip
 * for any filter/search/group/save action.
 *
 * "View by" combo bar (2026-08-25) — same mechanism as Sale vs Stock Mix's
 * own (SaleStockMixFacetedContent.tsx): Style+Color+Store stays the
 * default (today's FacetFilterBar + AG Grid, unchanged). Dragging one or
 * more attribute chips (Color / Size / Size Group / Gender / Season+Year /
 * MRP Range) into the drop zone re-aggregates the item-level `itemRows`
 * (from compute.ts) by that combination, network-wide — diagnostic
 * stock-vs-demand columns only, not a second allocator (see
 * replAttributes.ts's own header for why recommendedQty isn't part of
 * this view).
 */
export function ReplenishmentFacetedContent({ rows, itemRows }: { rows: Row[]; itemRows: ReplItemRow[] }) {
  const [combo, setCombo] = useState<AttributeKey[]>([]);
  const [mrpBucketSize, setMrpBucketSize] = useState(DEFAULT_MRP_BUCKET_SIZE);
  const [dragOverZone, setDragOverZone] = useState(false);
  const [state, setState] = useState<FacetFilterState>(emptyFilterState);
  // Persistent Store scope (2026-08-25 fix) — the "View by" attribute combo
  // replaces FacetFilterBar entirely with AttributeReplenishmentGrid below
  // (same as Sale vs Stock Mix's own combo bar), and FacetFilterBar was the
  // ONLY place Store filtering lived on this tab (just one of its facet
  // buttons) — so switching to an attribute combo silently made Store
  // filtering disappear. This dropdown lives OUTSIDE that toggle, always
  // visible, and scopes BOTH views (it's in addition to, not instead of,
  // the Store facet button still inside FacetFilterBar for the default
  // view, which supports multi-select).
  const [storeFilter, setStoreFilter] = useState("");

  const facets = useMemo<FacetDef<Row>[]>(
    () => [
      { key: "storeName", label: "Store", get: (r) => r.storeName },
      { key: "priority", label: "Priority", get: (r) => r.priority },
      { key: "action", label: "Action", get: (r) => r.action },
      { key: "trend", label: "Trend", get: (r) => r.trend },
      { key: "gender", label: "Gender", get: (r) => r.gender },
      { key: "season", label: "Season + Year", get: (r) => r.season },
    ],
    []
  );

  const advFields = useMemo<AdvField<Row>[]>(
    () => [
      { key: "styleNo", label: "Style No.", get: (r) => r.styleNo },
      { key: "color", label: "Color", get: (r) => r.color },
      { key: "storeName", label: "Store", get: (r) => r.storeName },
      { key: "soh", label: "SOH", get: (r) => r.soh, numeric: true },
      { key: "coverDays", label: "Cover days", get: (r) => r.coverDays, numeric: true },
      { key: "score", label: "Score", get: (r) => r.score, numeric: true },
      { key: "recommendedQty", label: "Recommended qty", get: (r) => r.recommendedQty, numeric: true },
      { key: "mrp", label: "MRP", get: (r) => r.mrp, numeric: true },
    ],
    []
  );

  // Default group-by order mirrors the reference project's "Style →
  // Colour → Problem → Action" — this domain's closest equivalent to
  // "Problem" is Priority (why the row needs attention at all).
  const groupByOptions = useMemo(
    () => [
      { key: "styleNo", label: "Style No." },
      { key: "color", label: "Color" },
      { key: "priority", label: "Priority" },
      { key: "action", label: "Action" },
      { key: "storeName", label: "Store" },
    ],
    []
  );
  const groupKeyGetters = useMemo<Record<string, (row: Row) => string>>(
    () => ({
      styleNo: (r) => r.styleNo,
      color: (r) => r.color,
      priority: (r) => r.priority,
      action: (r) => r.action,
      storeName: (r) => r.storeName,
    }),
    []
  );

  // Unique stores present in the data, in Row order (already store_id
  // ordered server-side) — no separate storeList fetch needed.
  const storeOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) if (!seen.has(r.storeId)) seen.set(r.storeId, r.storeName);
    return [...seen.entries()];
  }, [rows]);

  const scopedRows = useMemo(() => (storeFilter ? rows.filter((r) => r.storeId === storeFilter) : rows), [rows, storeFilter]);
  const scopedItemRows = useMemo(
    () => (storeFilter ? itemRows.filter((r) => r.storeId === storeFilter) : itemRows),
    [itemRows, storeFilter]
  );

  const filtered = useMemo(
    () => applyFacetFilter(scopedRows, facets, advFields, state),
    [scopedRows, facets, advFields, state]
  );
  const gridRows = useMemo(() => buildGroupedRows(filtered, state.groupBy, groupKeyGetters), [filtered, state.groupBy, groupKeyGetters]);

  // The attribute view is a second RENDERING of the same filtered set, not a
  // second, unfiltered dataset (2026-08-27 fix). The persistent Store
  // dropdown above already scoped both views, but it was the ONLY filter that
  // survived the toggle — Priority / Action / Trend / Gender / Season, the
  // quick search and every advanced condition all lived inside FacetFilterBar
  // and silently stopped applying the moment a combo chip went in. This
  // extends the storeFilter reasoning to the rest of the bar.
  //
  // `filtered` is style-color-per-store grain and `scopedItemRows` is
  // item_code grain, and several filterable fields (priority, action, trend,
  // score, coverDays, recommendedQty) are computed by the allocator and exist
  // only on the rolled-up Row — so rather than re-deriving the predicates at
  // item grain, keep the rows that survived the filter and take their items.
  // Exact: every item rolls up into exactly one style-color-per-store row,
  // hence storeId in the key (unlike the Mix tab, whose rows are store-scoped
  // as a whole rather than per-store).
  const filteredItemRows = useMemo(() => {
    if (filtered.length === scopedRows.length) return scopedItemRows;
    const keep = new Set(filtered.map((r) => `${r.styleNo}\u0000${r.color}\u0000${r.storeId}`));
    return scopedItemRows.filter((r) => keep.has(`${r.styleNo}\u0000${r.color}\u0000${r.storeId}`));
  }, [filtered, scopedRows, scopedItemRows]);

  const attributeRows = useMemo(
    () => aggregateReplenishmentByAttributes(filteredItemRows, combo, mrpBucketSize),
    [filteredItemRows, combo, mrpBucketSize]
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
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
          View by — drag attributes into the box to combine
        </span>
        {/* Always visible, in both the default and attribute-combo views —
            see storeFilter's own comment above for why. */}
        <label className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
          Store
          <select
            value={storeFilter}
            onChange={(e) => setStoreFilter(e.target.value)}
            className="border border-line-soft bg-surface px-2 py-1 text-[12.5px]"
          >
            <option value="">All stores</option>
            {storeOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mb-3">
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

          {/* Drop zone — the active combo. Empty = Style+Color+Store default. */}
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
              <span className="text-[12.5px] text-ink-3">
                Style + Color + Store (default) — drag a chip here to combine views
              </span>
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

      {/* Mounted in BOTH views — the filters it holds now apply to the
          attribute grid too, so unmounting it there would hide active state
          that is still in effect. Group-by is the one control that only means
          something in the default grid (the attribute view is already grouped
          by the combo), so its options are withheld while a combo is active
          rather than offering a no-op. */}
      <FacetFilterBar
        pageKey={PAGE_KEY}
        rows={scopedRows}
        facets={facets}
        advFields={advFields}
        groupByOptions={combo.length === 0 ? groupByOptions : []}
        state={state}
        onChange={setState}
      />

      {combo.length === 0 ? (
        <>
          <div className="mb-2 text-[12px] text-ink-3">
            {filtered.length === scopedRows.length
              ? `${filtered.length} rows`
              : `${filtered.length} of ${scopedRows.length} rows`}
          </div>
          <ReplenishmentGrid rows={gridRows} preserveOrder={state.groupBy.length > 0} />
        </>
      ) : (
        <>
          <div className="mb-2 text-[12px] text-ink-3">
            {attributeRows.length} {combo.map((a) => ATTRIBUTE_LABELS[a]).join(" + ").toLowerCase()} groups
            {filtered.length !== scopedRows.length &&
              ` · from ${filtered.length} of ${scopedRows.length} rows after filters`}
          </div>
          <AttributeReplenishmentGrid rows={attributeRows} attributes={combo} />
        </>
      )}
    </>
  );
}
