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
  storeOptions,
  storeLabels,
  storeFilters,
  selection,
  options,
  overridden,
}: {
  paramPrefix: string;
  from: string;
  to: string;
  compareFrom: string | null;
  compareTo: string | null;
  storeOptions: string[];
  storeLabels: Record<string, string>;
  storeFilters: string[];
  selection: AttributeSelection;
  options: AttributeOptions;
  overridden: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  /** Drops every param this bar owns, returning the table to the page scope. */
  function resetToPageScope() {
    window.dispatchEvent(new Event("progressbar:start"));
    const params = new URLSearchParams(searchParams.toString());
    for (const key of ["from", "to", "store", "compareFrom", "compareTo"]) params.delete(`${paramPrefix}${key}`);
    for (const facet of ATTRIBUTE_FACETS) params.delete(`${paramPrefix}${facet.param}`);
    // push() only — see StoreFilter's onChange for the refresh() race.
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="mb-3">
      <div className="flex flex-wrap items-end gap-5 border border-line-soft bg-surface px-3 py-2">
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
          />
        </div>

        <div className="hidden self-stretch border-l border-line-soft sm:block" />

        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">Period</div>
          <div className="flex flex-wrap items-center gap-2">
            <DateRangePicker from={from} to={to} paramPrefix={paramPrefix} />
            <ComparisonDateRangePicker
              from={from}
              to={to}
              compareFrom={compareFrom}
              compareTo={compareTo}
              paramPrefix={paramPrefix}
            />
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2 text-[11px]">
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

      <div className="mt-1.5">
        <AttributeFilterBar paramPrefix={paramPrefix} selection={selection} options={options} />
      </div>
    </div>
  );
}
