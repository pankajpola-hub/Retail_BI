"use client";

import {
  ATTRIBUTE_FACETS,
  attributeParamName,
  countActiveAttributeFacets,
  type AttributeOptions,
  type AttributeSelection,
} from "@/lib/sales/attributeFilter";
import { MultiSelectFilter } from "@/components/ui/StoreFilter";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { SlidersHorizontal } from "lucide-react";

/**
 * The eight product-attribute filters — Category, Subcategory, Gender, Market
 * Segment, Size Group, Season + Year, Color, Size — as one reusable bar.
 *
 * ---------------------------------------------------------------------------
 * Why paramPrefix exists
 * ---------------------------------------------------------------------------
 * This bar is instantiated FOUR times on /sales: once for the shared block
 * (hourly + store league + scheme penetration + the daily trend), and once
 * each for the three tables that are now self-contained mini-dashboards
 * (period, agent-wise, product attribute). All four write their state to the
 * URL so a filtered view stays shareable and bookmarkable — which means all
 * four would fight over `?cat=` if they wrote the same param names.
 *
 * Same fix, and the same reason, as app/(replenishment)/movement/page.tsx's
 * `mix_` prefix: that page put two independent tabs on one URL and prefixed
 * one tab's params so neither could clobber the other's. Here every instance
 * gets its own prefix ("attr_", "periodTable_attr_", ...) rather than one
 * instance being special-cased as the unprefixed default, because there is no
 * "primary" instance among four peers.
 *
 * ---------------------------------------------------------------------------
 * Cascading
 * ---------------------------------------------------------------------------
 * Options and counts are computed server-side by buildAttributeOptions() over
 * the section's UNFILTERED lines, following FacetFilterBar's facetOptionCounts
 * exactly: each facet's list is counted over the rows passing every OTHER
 * facet, and a currently-selected value is kept in the list at 0 rather than
 * dropped. MultiSelectFilter renders those zero-count values dimmed and still
 * clickable, so a selection can always be undone.
 *
 * Category -> Subcategory is narrowed additionally and explicitly: picking one
 * or more Categories reduces the Subcategory list to the subcategories of
 * those categories. That relationship is read from the data
 * (AttributeOptions.categoryOf), never from a hardcoded taxonomy — subcategory
 * names are ERP master data and change without this file. Verified live that
 * subcategories are a strict partition of categories, so a subcategory has
 * exactly one parent; see lib/sales/attributeFilter.ts's header for why only
 * this pair cascades structurally and the other six do not.
 */
export function AttributeFilterBar({
  paramPrefix,
  selection,
  options,
  label = "Attributes",
  onCommit,
}: {
  paramPrefix: string;
  selection: AttributeSelection;
  options: AttributeOptions;
  label?: string;
  /**
   * Intercepts every commit this bar makes — each facet's MultiSelectFilter
   * and the "Clear attributes" button — handing over the URLSearchParams it
   * would have navigated to instead (2026-09-05). Used by /sales' client-
   * fetched blocks so an attribute change re-fetches ONE block through a
   * Server Action rather than re-suspending the whole page's Server Component
   * tree. Absent, this bar navigates exactly as it always has.
   */
  onCommit?: (params: URLSearchParams) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const activeCount = countActiveAttributeFacets(selection);

  /**
   * Clears every facet belonging to THIS bar only — the prefix is what keeps
   * one section's "Clear" from wiping another section's filters, or the
   * page-level date/store scope.
   */
  function clearAll() {
    if (!onCommit) window.dispatchEvent(new Event("progressbar:start"));
    const params = new URLSearchParams(searchParams.toString());
    for (const facet of ATTRIBUTE_FACETS) params.delete(`${paramPrefix}${facet.param}`);
    if (onCommit) {
      onCommit(params);
      return;
    }
    // push() only, no refresh() — see StoreFilter's onChange for the race
    // that a bare refresh() after push() reintroduces.
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border border-line-soft bg-surface-2 px-3 py-2">
      <span className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
        <SlidersHorizontal className="h-3.5 w-3.5" />
        {label}
      </span>

      {ATTRIBUTE_FACETS.map((facet) => {
        const entries = options.counts[facet.key] ?? [];
        let values = entries.map(([v]) => v);

        // Category -> Subcategory cascade. Restricted to the selected
        // categories' own subcategories, but never dropping a subcategory the
        // user has already picked — same "you can always see and undo your own
        // selection" rule the zero-count dimming implements.
        if (facet.key === "subcategory" && selection.category.length > 0) {
          const chosen = new Set(selection.category);
          const picked = new Set(selection.subcategory);
          values = values.filter((v) => picked.has(v) || chosen.has(options.categoryOf[v] ?? ""));
        }

        return (
          <MultiSelectFilter
            key={facet.key}
            paramName={attributeParamName(paramPrefix, facet.key)}
            options={values}
            selected={selection[facet.key]}
            label={facet.label}
            allLabel="All"
            searchable={facet.searchable}
            counts={Object.fromEntries(entries)}
            onCommit={onCommit}
          />
        );
      })}

      {activeCount > 0 && (
        <button type="button" onClick={clearAll} className="text-[11px] text-accent hover:underline">
          Clear attributes ({activeCount})
        </button>
      )}
    </div>
  );
}
