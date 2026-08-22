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
import type { MixRow } from "@/lib/replenishment/mix";

const PAGE_KEY = "movement_mix";

/**
 * Phase 1 of the faceted-filtering system, second page (see
 * ReplenishmentFacetedContent.tsx for the first). Unlike Replenishment,
 * `store` here is NOT a pure display filter — computeSaleStockMix
 * genuinely aggregates at the store scope (or network-wide when storeId is
 * empty), so a per-store row breakdown doesn't exist to facet over
 * client-side without a bigger backend change. Store and the sales-period
 * window stay real server params in page.tsx; only style/color/status
 * (already plain post-filters on the fetched rows before this) move here.
 */
export function SaleStockMixFacetedContent({ rows }: { rows: MixRow[] }) {
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
      <SaleStockMixGrid rows={gridRows} />
    </>
  );
}
