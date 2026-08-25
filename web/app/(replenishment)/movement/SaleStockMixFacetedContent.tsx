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
import { aggregateMixByAttribute, ATTRIBUTE_LABELS, type AttributeKey } from "@/lib/replenishment/mixAttributes";

const PAGE_KEY = "movement_mix";

const ATTRIBUTE_PILLS: AttributeKey[] = ["styleColor", "color", "size", "gender", "season", "mrp"];
const DEFAULT_MRP_BUCKET_SIZE = 500;

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
 * "View by" pills (2026-08-25) — a second, independent axis on top of that:
 * Style+Color stays the default (exactly today's FacetFilterBar + AG Grid
 * with search/advanced-filter/group-by/saved-views), but any other pill
 * re-aggregates the same underlying item_code-level rows (`itemRows`, from
 * mix.ts) by a single attribute instead, entirely client-side — no new
 * server fetch on pill switch. A segmented-control row of pills, not a
 * dropdown: the current selection stays visibly highlighted at all times,
 * and "clearing" it is just clicking back to the Style+Color pill — no
 * separate clear affordance to explain (see the chat discussion this
 * shipped from for why a dropdown was rejected here).
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
  const [attribute, setAttribute] = useState<AttributeKey>("styleColor");
  const [mrpBucketSize, setMrpBucketSize] = useState(DEFAULT_MRP_BUCKET_SIZE);
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
    () => (attribute === "styleColor" ? [] : aggregateMixByAttribute(itemRows, attribute, totalSales, totalStock, mrpBucketSize)),
    [itemRows, attribute, totalSales, totalStock, mrpBucketSize]
  );

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">View by</span>
        <div className="flex flex-wrap gap-1.5">
          {ATTRIBUTE_PILLS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setAttribute(key)}
              className={
                attribute === key
                  ? "rounded-full bg-accent-soft px-3 py-1 text-[12.5px] font-semibold text-accent-ink"
                  : "rounded-full border border-line px-3 py-1 text-[12.5px] font-medium text-ink-3 hover:text-ink-2"
              }
            >
              {ATTRIBUTE_LABELS[key]}
            </button>
          ))}
        </div>
        {attribute === "mrp" && (
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

      {attribute === "styleColor" ? (
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
          <div className="mb-2 text-[12px] text-ink-3">{attributeRows.length} {ATTRIBUTE_LABELS[attribute].toLowerCase()} groups</div>
          <AttributeMixGrid rows={attributeRows} attribute={attribute} />
        </>
      )}
    </>
  );
}
