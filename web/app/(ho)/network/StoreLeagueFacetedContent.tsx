"use client";

import { useMemo, useState } from "react";
import {
  FacetFilterBar,
  applyFacetFilter,
  emptyFilterState,
  type AdvField,
  type FacetFilterState,
} from "@/components/ui/FacetFilterBar";
import { StoreLeagueDrilldown } from "@/app/(workspace)/workspace/StoreLeagueDrilldown";
import type { computeLeague } from "@/lib/sales/aggregate";

const PAGE_KEY = "network_store_league";

type LeagueRow = ReturnType<typeof computeLeague>[number];

/**
 * Phase 3 of the faceted-filtering system (Network) — lightest of the
 * three Network wirings: one row per store, no genuine categorical field
 * to facet on (unlike Agent-wise sales' Store or Store diagnosis'
 * Tone/Primary issue), so facets/groupByOptions are both empty arrays —
 * FacetFilterBar renders just search + Advanced + Saved views (confirmed
 * by reading FacetFilterBar.tsx: empty arrays hide those controls
 * entirely, not render them empty). StoreLeagueDrilldown itself is NOT
 * modified — it's also used by the Workspace Builder with a plain,
 * unfiltered league array — this wrapper only filters `league` before
 * handing it to that existing, untouched component.
 */
export function StoreLeagueFacetedContent({ league, from, to }: { league: LeagueRow[]; from: string; to: string }) {
  const [state, setState] = useState<FacetFilterState>(emptyFilterState);

  const advFields = useMemo<AdvField<LeagueRow>[]>(
    () => [
      { key: "name", label: "Store", get: (r) => r.name },
      { key: "net", label: "Net", get: (r) => r.net, numeric: true },
      { key: "bills", label: "Bills", get: (r) => r.bills, numeric: true },
      { key: "qty", label: "Qty", get: (r) => r.qty, numeric: true },
      { key: "atv", label: "ATV", get: (r) => r.atv ?? null, numeric: true },
      { key: "upt", label: "UPT", get: (r) => r.upt ?? null, numeric: true },
      { key: "discountPct", label: "Discount %", get: (r) => r.discountPct ?? null, numeric: true },
    ],
    []
  );

  const filtered = useMemo(() => applyFacetFilter(league, [], advFields, state), [league, advFields, state]);

  return (
    <>
      <FacetFilterBar pageKey={PAGE_KEY} rows={league} facets={[]} advFields={advFields} groupByOptions={[]} state={state} onChange={setState} />
      <StoreLeagueDrilldown league={filtered} from={from} to={to} />
    </>
  );
}
