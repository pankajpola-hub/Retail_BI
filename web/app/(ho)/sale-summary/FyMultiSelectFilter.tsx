"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { currentYm, recentFinancialYears, financialYearRange } from "@/lib/saleSummary/month";

/**
 * Financial-Year MULTI-select filter (2026-09-16, per Pankaj) — sits next to
 * MonthRangePicker in the sticky header and drives the SAME fromMonth/toMonth
 * URL params that picker does, rather than a separate param: the page's
 * query (ChannelSalesSection) is a single contiguous `bill_month` range, so
 * there is only one range concept to express, and this control is just a
 * friendlier way to set it by whole financial year instead of raw month
 * dropdowns.
 *
 * SELECTING MULTIPLE YEARS SPANS THEM, IT DOES NOT EXCLUDE THE GAP —
 * picking FY2023-24 and FY2025-26 (skipping FY2024-25) still queries the
 * one continuous range April 2023 - March 2026, because that's what the
 * underlying range query can express. A caption below the checklist says so
 * explicitly whenever the current selection has a gap, rather than silently
 * including data the user might not expect.
 */
export function FyMultiSelectFilter({ fromMonth, toMonth }: { fromMonth: string; toMonth: string }) {
  const now = currentYm();
  const allFys = recentFinancialYears(now, 6); // newest first, same order MonthRangePicker's own FY presets use

  const isFyWithinRange = (fy: string) => {
    const r = financialYearRange(fy);
    return r.fromMonth >= fromMonth && r.toMonth <= toMonth;
  };

  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(allFys.filter(isFyWithinRange)));
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    setSelected(new Set(allFys.filter(isFyWithinRange)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromMonth, toMonth]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  function toggle(fy: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(fy)) next.delete(fy);
      else next.add(fy);
      return next;
    });
  }

  function apply() {
    if (selected.size === 0) {
      setOpen(false);
      return;
    }
    const ranges = [...selected].map(financialYearRange);
    const from = ranges.reduce((min, r) => (r.fromMonth < min ? r.fromMonth : min), ranges[0]!.fromMonth);
    const to = ranges.reduce((max, r) => (r.toMonth > max ? r.toMonth : max), ranges[0]!.toMonth);
    const params = new URLSearchParams(searchParams.toString());
    params.set("fromMonth", from);
    params.set("toMonth", to);
    window.dispatchEvent(new Event("progressbar:start"));
    router.push(`${pathname}?${params.toString()}`);
    setOpen(false);
  }

  // Gap check: selected years' positions in allFys (newest-first) must be
  // consecutive indices for the selection to be one unbroken run.
  const selectedIndices = allFys.map((fy, i) => (selected.has(fy) ? i : -1)).filter((i) => i >= 0);
  const hasGap = selectedIndices.length > 1 && selectedIndices[selectedIndices.length - 1]! - selectedIndices[0]! + 1 !== selectedIndices.length;

  const label = selected.size === 0 ? "Financial years" : selected.size === 1 ? [...selected][0] : `${selected.size} financial years`;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="border border-line bg-surface px-3 py-1.5 text-[13px] text-ink-2"
      >
        {label}
      </button>

      {open && (
        <div className="absolute left-0 z-10 mt-1 w-[240px] border border-line bg-surface p-2 shadow-lg">
          <div className="max-h-[220px] overflow-y-auto">
            {allFys.map((fy) => (
              <label key={fy} className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[13px] text-ink-2 hover:bg-surface-2">
                <input type="checkbox" checked={selected.has(fy)} onChange={() => toggle(fy)} />
                {fy}
              </label>
            ))}
          </div>
          {hasGap && (
            <p className="mt-1.5 px-2 text-[11px] text-ink-3">
              Non-adjacent years selected — the months in between are included too (one continuous range).
            </p>
          )}
          <button onClick={apply} className="mt-2 w-full bg-accent py-1.5 text-[13px] font-semibold text-accent-fg">
            Apply
          </button>
        </div>
      )}
    </div>
  );
}
