"use server";

import { createClient, fetchAllRows } from "@/lib/data/client";
import type { QueryChain } from "@/lib/data/client";
import { requirePageAccess } from "@/lib/auth/roles";
import { timeAll } from "@/lib/perf/timing";
import {
  SALE_LINE_SELECT,
  applyAttributeFilter,
  buildAttributeOptions,
  type AttributeOptions,
  type AttributeSelection,
  type SaleLineRow,
} from "@/lib/sales/attributeFilter";
import { computeQtySplitFromLines, computeTotalsFromLines, type LineTotals, type QtySplit } from "@/lib/sales/lineAggregates";
import { resolveTableScope, type SearchParamsShape } from "@/lib/sales/tableScope";

/**
 * Server Actions backing /sales' CLIENT-FETCHED blocks (2026-09-05, item 4).
 *
 * ---------------------------------------------------------------------------
 * The problem this exists to solve
 * ---------------------------------------------------------------------------
 * Every independently-filterable block on /sales drives its filters through
 * prefixed URL searchParams. That is a good, shareable state model, but it has
 * one architectural cost: changing ANY block's filter is a Next.js navigation,
 * which re-runs the whole page's Server Component tree and re-suspends every
 * Suspense boundary on it. Six blocks, each with its own line-grain fetch, all
 * re-render because one of them changed a date — a full-page flash for a
 * change that affected one card.
 *
 * A block converted to this path keeps the exact same filter UI and the exact
 * same scope semantics, but commits its filter changes to LOCAL STATE and
 * re-fetches ONLY ITSELF through the action below. Nothing else on the page
 * re-renders, and the block shows its own small pending state.
 *
 * ---------------------------------------------------------------------------
 * Why the wire format is URLSearchParams
 * ---------------------------------------------------------------------------
 * Every control in TableScopeBar already knows how to express its change as
 * "the URL you would have navigated to". Handing that object over (via each
 * control's new `onCommit`) and passing it here as a plain record means the
 * scope is parsed by resolveTableScope — the SAME parser the server-rendered
 * blocks use — rather than by a second, client-side reimplementation that
 * could drift on the inheritance rule (an unset per-block param inherits the
 * page-level value; a present-but-empty `store` does not).
 *
 * ---------------------------------------------------------------------------
 * A Server Action is a public endpoint
 * ---------------------------------------------------------------------------
 * It is reachable by anyone who can POST to this app, with any arguments they
 * like — the caller's props are NOT a trust boundary. So this re-runs
 * requirePageAccess("sales") on every call, exactly as the page does, and the
 * store scoping underneath is unchanged: sales.vw_ebo_sale_attribute_lines is
 * row-filtered by core.fn_user_store_ids(), and a storeFilters list can only
 * ever narrow that further, never widen it. A forged `pageScope.storeFilters`
 * therefore cannot reach another user's stores.
 */

export type PeriodComparisonData = {
  from: string;
  to: string;
  compareFrom: string | null;
  compareTo: string | null;
  comparing: boolean;
  storeFilters: string[];
  selection: AttributeSelection;
  overridden: boolean;
  options: AttributeOptions;
  current: LineTotals;
  currentSplit: QtySplit;
  comparison: LineTotals | null;
  comparisonSplit: QtySplit | null;
};

/** The page-level values an untouched per-block control inherits. */
export type PageScopeInput = {
  from: string;
  to: string;
  compareFrom: string | null;
  compareTo: string | null;
  storeFilters: string[];
};

/**
 * Loads the "Period comparison" block for one scope.
 *
 * Called BOTH from the page's own server render (for the block's initial
 * state) and from the client wrapper on every filter change, so there is one
 * definition of this block's data, not a server one and a client one.
 */
export async function loadPeriodComparison(
  searchParams: SearchParamsShape,
  prefix: string,
  pageScope: PageScopeInput
): Promise<PeriodComparisonData> {
  await requirePageAccess("sales");
  const supabase = await createClient();
  const scope = resolveTableScope(searchParams, prefix, pageScope);

  const applyStore = <T extends { eq: (col: string, val: string) => T; in: (col: string, vals: string[]) => T }>(q: T): T => {
    if (scope.storeFilters.length === 0) return q;
    if (scope.storeFilters.length === 1) return q.eq("store_id", scope.storeFilters[0] as string);
    return q.in("store_id", scope.storeFilters);
  };

  // Paged via fetchAllRows for the usual reason: PostgREST's project "Max
  // Rows" caps every response at 1000 with no error, and this is line grain.
  // The .order() calls are load-bearing — .range() paging is only a correct
  // partition if the server-side ordering is stable across REST calls.
  const fetchLines = (from: string, to: string) =>
    fetchAllRows<SaleLineRow>(() =>
      applyStore(
        supabase
          .schema("sales")
          .from<SaleLineRow>("vw_ebo_sale_attribute_lines")
          .select(SALE_LINE_SELECT)
          .gte("bill_date", from)
          .lte("bill_date", to)
          .order("bill_date", { ascending: true })
          .order("bill_no", { ascending: true })
          .order("item_code", { ascending: true })
      ) as unknown as QueryChain<SaleLineRow>
    );

  const [lines, compareLines] = await timeAll("sales:period_comparison", [
    fetchLines(scope.from, scope.to),
    scope.comparing ? fetchLines(scope.compareFrom as string, scope.compareTo as string) : Promise.resolve([] as SaleLineRow[]),
  ] as const);

  const all = lines ?? [];
  // Options/counts from the UNFILTERED rows so the bar's cascading counts stay
  // usable; the figures from the filtered ones. Both ranges go through the
  // SAME selection — the whole point of this block.
  const filtered = applyAttributeFilter(all, scope.selection);
  const filteredCompare = applyAttributeFilter(compareLines ?? [], scope.selection);

  return {
    from: scope.from,
    to: scope.to,
    compareFrom: scope.compareFrom,
    compareTo: scope.compareTo,
    comparing: scope.comparing,
    storeFilters: scope.storeFilters,
    selection: scope.selection,
    overridden: scope.overridden,
    options: buildAttributeOptions(all, scope.selection),
    current: computeTotalsFromLines(filtered),
    currentSplit: computeQtySplitFromLines(filtered),
    comparison: scope.comparing ? computeTotalsFromLines(filteredCompare) : null,
    comparisonSplit: scope.comparing ? computeQtySplitFromLines(filteredCompare) : null,
  };
}
