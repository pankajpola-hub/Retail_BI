/**
 * Per-table scope resolution for /sales' three self-contained tables.
 *
 * The period table, agent-wise table and product-attribute table each became
 * their own mini-dashboard: their own Location, Period, comparison period and
 * attribute filter, independent of the page-level ScopeBar and of each other.
 * That means each needs its own namespace in the URL, and its own fallback
 * when the user has not touched its controls.
 *
 * FALLBACK RULE: an unset per-table control inherits the PAGE-LEVEL value
 * rather than a fixed default. So a table a user has never touched keeps
 * tracking the page's scope bar exactly as it did before it became
 * independent — independence is something you opt into by touching the
 * table's own control, not a break the page inflicts on load. The moment a
 * table's own param is present it wins outright, page-level included.
 *
 * Comparison follows the page's own half-a-range rule: a comparison is only
 * active when BOTH ends are present, so a hand-edited URL cannot produce a
 * delta against a window nobody asked for.
 */

import { parseAttributeSelection, type AttributeSelection } from "./attributeFilter";

export type SearchParamsShape = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export type TableScope = {
  from: string;
  to: string;
  compareFrom: string | null;
  compareTo: string | null;
  comparing: boolean;
  storeFilters: string[];
  selection: AttributeSelection;
  /** True when this table is running on anything other than the page-level scope. */
  overridden: boolean;
};

export function resolveTableScope(
  searchParams: SearchParamsShape,
  prefix: string,
  pageLevel: { from: string; to: string; compareFrom: string | null; compareTo: string | null; storeFilters: string[] }
): TableScope {
  const rawFrom = one(searchParams[`${prefix}from`]);
  const rawTo = one(searchParams[`${prefix}to`]);
  const rawStore = one(searchParams[`${prefix}store`]);
  const rawCompareFrom = one(searchParams[`${prefix}compareFrom`]);
  const rawCompareTo = one(searchParams[`${prefix}compareTo`]);

  const from = rawFrom || pageLevel.from;
  const to = rawTo || pageLevel.to;

  // A per-table comparison overrides the page-level one entirely; with neither
  // set there is no comparison. Both ends required, same as the page.
  const hasOwnCompare = Boolean(rawCompareFrom && rawCompareTo);
  const compareFrom = hasOwnCompare ? (rawCompareFrom as string) : pageLevel.compareFrom;
  const compareTo = hasOwnCompare ? (rawCompareTo as string) : pageLevel.compareTo;

  // `?prefix_store=` present-but-empty is a real state — "this table shows ALL
  // stores", chosen deliberately — and must not fall back to the page's
  // selection. Only an ABSENT param inherits.
  const storeFilters =
    rawStore === undefined ? pageLevel.storeFilters : rawStore.split(",").filter(Boolean);

  const selection = parseAttributeSelection(searchParams, prefix);

  return {
    from,
    to,
    compareFrom,
    compareTo,
    comparing: Boolean(compareFrom && compareTo),
    storeFilters,
    selection,
    overridden: Boolean(rawFrom || rawTo || rawStore !== undefined || hasOwnCompare),
  };
}
