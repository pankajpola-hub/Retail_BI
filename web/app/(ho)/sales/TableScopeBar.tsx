"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { MultiSelectFilter } from "@/components/ui/StoreFilter";
import { DateRangePicker } from "@/components/ui/DateRangePicker";
import { ComparisonDateRangePicker } from "@/components/ui/ComparisonDateRangePicker";
import { AttributeFilterBar } from "./AttributeFilterBar";
import { ATTRIBUTE_FACETS, type AttributeOptions, type AttributeSelection } from "@/lib/sales/attributeFilter";

/**
 * One table's own scope controls — Location, Period, Compare and the eight
 * product-attribute filters — laid out as a compact bar above that table.
 *
 * Deliberately the SAME components the page-level ScopeBar uses
 * (MultiSelectFilter / DateRangePicker / ComparisonDateRangePicker), just
 * pointed at prefixed params, rather than a second set of date/store controls
 * with their own behaviour. Each of those components gained an optional
 * `paramPrefix` (default "", so every other caller in the app is unchanged)
 * precisely so this reuse was possible without forking them.
 *
 * NO VERTICAL SELECTOR, deliberately. The page-level ScopeBar offers
 * Vertical / Location / Period, but all three tables this bar serves are
 * EBO-only by DATA, not by preference: sales.vw_ecomm_order_lines carries no
 * season, gender, size_group, category or market_segment at all, which is why
 * ProductAttributeSection is gated to EBO in the first place. A Vertical
 * control here could only ever offer "EBO" — a control that narrows nothing,
 * and worse, one that implies an ECOM view exists behind it. Reported as a
 * deviation rather than rendered as a dead control.
 *
 * INHERITANCE. An untouched control shows the page-level value and stays in
 * step with the page scope bar (see resolveTableScope). `overridden` drives
 * the "independent" note and the reset, so it is always visible whether a
 * table is following the page or running on its own scope.
 */
export function TableScopeBar({
  paramPrefix,
  from,
  to,
  compareFrom,
  compareTo,
  storeOptions = [],
  storeLabels = {},
  storeFilters = [],
  selection,
  options,
  overridden,
  showAttributes = true,
  showLocation = true,
  showCompare = true,
  compareHint,
  onCommit,
  pending = false,
}: {
  paramPrefix: string;
  from: string;
  to: string;
  compareFrom: string | null;
  compareTo: string | null;
  // Optional because a bar with showLocation/showAttributes off has nothing to
  // do with them — better than making callers pass empty placeholders.
  storeOptions?: string[];
  storeLabels?: Record<string, string>;
  storeFilters?: string[];
  selection?: AttributeSelection;
  options?: AttributeOptions;
  overridden: boolean;
  /**
   * Footfall opts BOTH of these out. Its figures come from
   * ops.vw_ebo_conversion_daily and ops.vw_footfall_completeness — a store x
   * day count of people through the door, with no item and therefore no
   * product attribute to filter by, and it is already scoped by the page's
   * store picker. Rendering an attribute bar there would be a control that
   * silently does nothing, which is worse than not offering it.
   */
  showAttributes?: boolean;
  showLocation?: boolean;
  /**
   * "Sales trend by period" opts out. That table's rows ARE consecutive
   * periods and its change column is already period-over-period between
   * adjacent rows — a second, range-vs-range comparison on the same table is
   * what made the two readings impossible to tell apart (the "-94.4%" report:
   * a full month against a 4-day sliver). Range-vs-range now lives in its own
   * "Period comparison" table, which never buckets by calendar period at all.
   */
  showCompare?: boolean;
  /** Overrides the "Compare to…" copy where the baseline means something more specific. */
  compareHint?: string;
  /**
   * Turns this bar from a NAVIGATING control into a CONTROLLED one
   * (2026-09-05). Every control below builds the same prefixed
   * URLSearchParams it always did; with `onCommit` it hands that over instead
   * of calling router.push, so the owning block can re-fetch just itself
   * through a Server Action. The params are still the interchange format on
   * purpose: the block passes them straight back to resolveTableScope
   * server-side, so there is exactly ONE parser for a block's scope whether it
   * came from the URL or from a click.
   */
  onCommit?: (params: URLSearchParams) => void;
  /** Shows a "Updating…" note in the bar while an onCommit fetch is in flight. */
  pending?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  /** Drops every param this bar owns, returning the table to the page scope. */
  function resetToPageScope() {
    if (!onCommit) window.dispatchEvent(new Event("progressbar:start"));
    const params = new URLSearchParams(searchParams.toString());
    for (const key of ["from", "to", "store", "compareFrom", "compareTo"]) params.delete(`${paramPrefix}${key}`);
    for (const facet of ATTRIBUTE_FACETS) params.delete(`${paramPrefix}${facet.param}`);
    if (onCommit) {
      onCommit(params);
      return;
    }
    // push() only — see StoreFilter's onChange for the refresh() race.
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="mb-3">
      <div className="flex flex-wrap items-end gap-5 border border-line-soft bg-surface px-3 py-2">
        {showLocation && (
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">Location</div>
          <MultiSelectFilter
            paramName={`${paramPrefix}store`}
            options={storeOptions}
            labels={storeLabels}
            selected={storeFilters}
            allLabel="All stores"
            searchable={storeOptions.length > 12}
            // Present-but-empty is a real choice here ("this table shows all
            // stores"), distinct from absent ("follow the page"). Without
            // this, clearing the picker would silently snap back to the
            // page's store selection instead of clearing.
            clearAsEmptyParam
            onCommit={onCommit}
          />
        </div>
        )}

        {showLocation && <div className="hidden self-stretch border-l border-line-soft sm:block" />}

        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">Period</div>
          <div className="flex flex-wrap items-center gap-2">
            <DateRangePicker from={from} to={to} paramPrefix={paramPrefix} onCommit={onCommit} />
            {showCompare && (
              <ComparisonDateRangePicker
                from={from}
                to={to}
                compareFrom={compareFrom}
                compareTo={compareTo}
                paramPrefix={paramPrefix}
                onCommit={onCommit}
              />
            )}
          </div>
          {compareHint && <p className="mt-1 text-[11px] text-ink-3">{compareHint}</p>}
        </div>

        <div className="ml-auto flex items-center gap-2 text-[11px]">
          {pending && <span className="text-ink-3">Updating…</span>}
          <span className={overridden ? "text-accent-ink" : "text-ink-3"}>
            {overridden ? "Independent scope" : "Following page scope"}
          </span>
          {overridden && (
            <button type="button" onClick={resetToPageScope} className="text-accent hover:underline">
              Reset
            </button>
          )}
        </div>
      </div>

      {showAttributes && selection && options && (
        <div className="mt-1.5">
          <AttributeFilterBar paramPrefix={paramPrefix} selection={selection} options={options} onCommit={onCommit} />
        </div>
      )}
    </div>
  );
}
