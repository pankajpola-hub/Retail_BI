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
import type { Row } from "@/lib/replenishment/compute";

const PAGE_KEY = "movement_replenishment";

/**
 * Phase 1 of the faceted-filtering system (see the plan file) — the
 * Replenishment tab's instant, client-side search/facet/chip/group-by/
 * saved-view layer, wired to the full un-paginated row set the server
 * still computes once (computeReplenishmentRows, unchanged). Everything
 * below is a pure client-side derivation of `rows`; no server round-trip
 * for any filter/search/group/save action.
 */
export function ReplenishmentFacetedContent({ rows }: { rows: Row[] }) {
  const [state, setState] = useState<FacetFilterState>(emptyFilterState);

  const facets = useMemo<FacetDef<Row>[]>(
    () => [
      { key: "storeName", label: "Store", get: (r) => r.storeName },
      { key: "priority", label: "Priority", get: (r) => r.priority },
      { key: "action", label: "Action", get: (r) => r.action },
      { key: "trend", label: "Trend", get: (r) => r.trend },
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
      <ReplenishmentGrid rows={gridRows} preserveOrder={state.groupBy.length > 0} />
    </>
  );
}
