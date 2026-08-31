"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { shiftMonth } from "@/lib/saleSummary/month";
import { useSaleSummaryState } from "./SaleSummaryShell";

/**
 * "Compare to" range picker for /sale-summary (2026-08-31 redesign #2) —
 * month-grain sibling of ComparisonDateRangePicker.tsx (the day-grain
 * version already wired up on /sales via compareFrom/compareTo), and the
 * comparison-side analogue of this page's own MonthRangePicker. Drives
 * ?compareFromMonth=&compareToMonth=, sitting right next to
 * MonthRangePicker in page.tsx's sticky header (per Pankaj: "shift this on
 * header where main date filter freezed").
 *
 * OPTIONAL BY DESIGN (per Pankaj: "'Comparison settings' should be optional
 * only if user wants to use only"): comparison is "on" exactly when BOTH
 * compareFromMonth and compareToMonth are present in the URL — there is no
 * separate on/off flag. This button IS that toggle: it reads as "+ Compare"
 * (dashed border) when off, and as the active range (solid border) when on,
 * with an explicit "Turn comparison off" action that clears both params.
 * page.tsx only fetches the comparison row set when both params are present,
 * so an unopened picker costs nothing extra.
 *
 * PRESETS computed FROM the main range, not fixed: "Previous period" is the
 * same-width window immediately before `fromMonth` (e.g. main = Jan-Mar 2026
 * -> Oct-Dec 2025), "Same period last year" is `fromMonth`/`toMonth` shifted
 * back 12 months (Jan-Mar 2025) — replaces the old rigid single-month
 * MoM/YoY toggle now that comparison.ts compares whole ranges, not one
 * latest month vs one fixed baseline. A manual custom-range form (same UX
 * shape as MonthRangePicker's own) covers "any range vs any range".
 *
 * The like-to-like toggle also lives here now (not in SaleSummaryClient's
 * body) — per Pankaj's ask 3, the WHOLE comparison control (range picker +
 * like-to-like) belongs in the header next to the main date filter. It reads
 * `likeToLike` from SaleSummaryShell's Context directly (this component
 * already renders inside <SaleSummaryShell> in page.tsx) and is only shown
 * once comparison is active — toggling like-to-like when there's nothing to
 * compare against is meaningless.
 */
function monthRangeWidthMonths(fromMonth: string, toMonth: string): number {
  const [fy, fm] = fromMonth.split("-").map(Number);
  const [ty, tm] = toMonth.split("-").map(Number);
  return (ty as number) * 12 + (tm as number) - ((fy as number) * 12 + (fm as number)) + 1;
}

export function ComparisonMonthRangePicker({
  fromMonth,
  toMonth,
  compareFromMonth,
  compareToMonth,
}: {
  fromMonth: string;
  toMonth: string;
  compareFromMonth: string | null;
  compareToMonth: string | null;
}) {
  const active = Boolean(compareFromMonth && compareToMonth);
  const { likeToLike, setLikeToLike } = useSaleSummaryState();
  const [open, setOpen] = useState(false);
  const width = monthRangeWidthMonths(fromMonth, toMonth);
  const defaultPrevFrom = shiftMonth(fromMonth, -width);
  const defaultPrevTo = shiftMonth(fromMonth, -1);
  const [customFrom, setCustomFrom] = useState(compareFromMonth ?? defaultPrevFrom);
  const [customTo, setCustomTo] = useState(compareToMonth ?? defaultPrevTo);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    setCustomFrom(compareFromMonth ?? defaultPrevFrom);
    setCustomTo(compareToMonth ?? defaultPrevTo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareFromMonth, compareToMonth, fromMonth, toMonth]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  function apply(newFrom: string | null, newTo: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (newFrom && newTo) {
      // Swap if picked backwards — never silently produce an inverted range.
      const [a, b] = newFrom <= newTo ? [newFrom, newTo] : [newTo, newFrom];
      params.set("compareFromMonth", a);
      params.set("compareToMonth", b);
    } else {
      params.delete("compareFromMonth");
      params.delete("compareToMonth");
    }
    router.push(`${pathname}?${params.toString()}`);
    setOpen(false);
  }

  const prevPeriod: [string, string] = [shiftMonth(fromMonth, -width), shiftMonth(fromMonth, -1)];
  const prevYear: [string, string] = [shiftMonth(fromMonth, -12), shiftMonth(toMonth, -12)];

  const label = active ? (compareFromMonth === compareToMonth ? compareFromMonth! : `${compareFromMonth} – ${compareToMonth}`) : "+ Compare";

  return (
    <div className="flex items-center gap-2">
      <div className="relative" ref={ref}>
        <button
          onClick={() => setOpen((v) => !v)}
          className={`border px-3 py-1.5 text-[13px] ${
            active ? "border-line bg-accent-soft text-accent-ink" : "border-dashed border-line bg-surface text-ink-3"
          }`}
        >
          {label}
        </button>

        {open && (
        <div className="absolute right-0 z-10 mt-1 flex w-[340px] border border-line bg-surface shadow-lg">
          <ul className="w-[160px] border-r border-line-soft py-2">
            <li>
              <button
                className="w-full px-3 py-1.5 text-left text-[13px] text-ink-2 hover:bg-surface-2"
                onClick={() => apply(prevPeriod[0], prevPeriod[1])}
              >
                Previous period
              </button>
            </li>
            <li>
              <button
                className="w-full px-3 py-1.5 text-left text-[13px] text-ink-2 hover:bg-surface-2"
                onClick={() => apply(prevYear[0], prevYear[1])}
              >
                Same period last year
              </button>
            </li>
            {active && (
              <li>
                <button
                  className="w-full px-3 py-1.5 text-left text-[13px] text-crit hover:bg-surface-2"
                  onClick={() => apply(null, null)}
                >
                  Turn comparison off
                </button>
              </li>
            )}
          </ul>
          <form
            className="flex flex-1 flex-col gap-2 p-3"
            onSubmit={(e) => {
              e.preventDefault();
              apply(customFrom, customTo);
            }}
          >
            <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Custom comparison</span>
            <label className="flex flex-col gap-1 text-[12px] text-ink-2">
              From
              <input
                type="month"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="border border-line px-2 py-1 text-[13px]"
              />
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-ink-2">
              To
              <input
                type="month"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="border border-line px-2 py-1 text-[13px]"
              />
            </label>
            <button type="submit" className="mt-1 bg-accent py-1.5 text-[13px] font-semibold text-accent-fg">
              Compare
            </button>
          </form>
        </div>
        )}
      </div>
      {active && (
        <label className="ml-1 flex min-h-[32px] items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-[12.5px] text-ink-2">
          <input type="checkbox" checked={likeToLike} onChange={(e) => setLikeToLike(e.target.checked)} />
          Like-to-like
        </label>
      )}
    </div>
  );
}
