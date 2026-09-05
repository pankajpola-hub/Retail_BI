"use client";

import { useCallback, useState, useTransition } from "react";
import { CalendarRange } from "lucide-react";
import { TableScopeBar } from "./TableScopeBar";
import { TableCompareStrip } from "./TableCompareStrip";
import { loadPeriodComparison, type PageScopeInput, type PeriodComparisonData } from "./actions";

/**
 * "Period comparison — EBO", CLIENT-FETCHED (2026-09-05, item 4).
 *
 * This is the proven pattern for the rest of /sales' independently-filterable
 * blocks, built here first because this block is the smallest: one scope bar
 * and one totals strip, no grain toggle, no faceted grid.
 *
 * WHAT CHANGED, AND WHAT DELIBERATELY DID NOT. The filter UI is the SAME
 * TableScopeBar every other block uses, and the scope semantics are the same
 * resolveTableScope rules (including page-level inheritance for an untouched
 * control) — the scope is still parsed server-side, from the very
 * URLSearchParams the controls already build. The only difference is where
 * that object goes: to a Server Action that reloads THIS BLOCK, instead of to
 * router.push, which reloads the whole page's Server Component tree and makes
 * five other blocks re-suspend because this one's date changed.
 *
 * THE TRADE-OFF, STATED. This block's filter state is no longer in the URL,
 * so it is not shareable or bookmarkable and does not survive a reload, which
 * the searchParams-driven blocks do. It IS still URL-seedable: the page's
 * server render passes `initial` through the same action, so a link carrying
 * ?compareTable_from=... still opens on that scope. Only changes made after
 * load are local. That is the intended shape — the page-level ScopeBar keeps
 * URL state precisely because it is the one people share.
 *
 * ERRORS ARE SHOWN, NOT SWALLOWED. A failed action leaves the last good data
 * on screen with a message beside the bar, rather than blanking the block or
 * silently keeping stale numbers under a filter that appears to have applied.
 */
export function PeriodComparisonBlock({
  initial,
  prefix,
  pageScope,
  storeOptions,
  storeLabels,
}: {
  initial: PeriodComparisonData;
  prefix: string;
  pageScope: PageScopeInput;
  storeOptions: string[];
  storeLabels: Record<string, string>;
}) {
  const [data, setData] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const onCommit = useCallback(
    (params: URLSearchParams) => {
      setError(null);
      // URLSearchParams itself is not serializable across the action boundary
      // — a plain record is. Last-wins on a repeated key, matching how
      // Next.js hands searchParams to the page for these single-value params.
      const record: Record<string, string> = {};
      params.forEach((value, key) => {
        record[key] = value;
      });
      startTransition(async () => {
        try {
          setData(await loadPeriodComparison(record, prefix, pageScope));
        } catch {
          setError("Could not load this comparison. The figures below are from the previous filter.");
        }
      });
    },
    [prefix, pageScope]
  );

  return (
    <div className={`rounded-lg border border-line-soft bg-surface p-4 shadow-sm ${isPending ? "opacity-60" : ""}`}>
      <div className="flex items-center gap-1.5 text-ink-3">
        <CalendarRange className="h-4 w-4" />
        <span className="text-[10.5px] font-semibold uppercase tracking-wide">Period comparison — EBO</span>
      </div>
      <p className="mt-1 text-[11px] text-ink-3">
        Whole-range total vs whole-range total. Never bucketed by calendar period, so a full month and a part month
        compare as the two totals they are. Filter changes here reload only this block.
      </p>

      <div className="mt-2">
        <TableScopeBar
          paramPrefix={prefix}
          from={data.from}
          to={data.to}
          compareFrom={data.compareFrom}
          compareTo={data.compareTo}
          storeOptions={storeOptions}
          storeLabels={storeLabels}
          storeFilters={data.storeFilters}
          selection={data.selection}
          options={data.options}
          overridden={data.overridden}
          onCommit={onCommit}
          pending={isPending}
          compareHint="Both ranges are narrowed by the SAME attribute filter above, so the comparison stays like-for-like."
        />

        {error && (
          <p role="alert" className="mb-3 border border-line-soft bg-surface-2 px-3 py-2 text-[12px] text-crit">
            {error}
          </p>
        )}

        {data.comparison && data.comparisonSplit ? (
          <TableCompareStrip
            current={data.current}
            comparison={data.comparison}
            compareFrom={data.compareFrom as string}
            compareTo={data.compareTo as string}
            currentSplit={data.currentSplit}
            comparisonSplit={data.comparisonSplit}
          />
        ) : (
          <p className="border border-line-soft bg-surface-2 px-3 py-6 text-center text-[12.5px] text-ink-3">
            Set a <strong>Compare</strong> range above (Previous period, Previous year, or any custom range) to see this
            range&apos;s totals against it.
          </p>
        )}
      </div>
    </div>
  );
}
