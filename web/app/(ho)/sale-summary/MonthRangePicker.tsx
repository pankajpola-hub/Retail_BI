"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { currentYm, shiftMonth } from "@/lib/saleSummary/month";

/**
 * Month-grain sibling of DateRangePicker.tsx, built specifically for this
 * page rather than adapting the day-level picker: the source data
 * (raw_logic.channel_sales_summary) has no day-of-month at all — every row's
 * bill_month is already the 1st of its month — so a day-level calendar
 * widget would let a user pick a range that silently snaps to month
 * boundaries anyway, which is more confusing than a picker that's honestly
 * month-grain to begin with. Uses native <input type="month">, and (unlike
 * DateRangePicker's `iso()`) never routes through a `new Date(...)` object
 * at all — see lib/saleSummary/month.ts's header for why that sidesteps the
 * IST day-level bug DateRangePicker's own header documents, by construction
 * rather than by care.
 */
type Preset = { label: string; range: (nowYm: string) => [string, string] };
const PRESETS: Preset[] = [
  { label: "This month", range: (now) => [now, now] },
  { label: "Last month", range: (now) => [shiftMonth(now, -1), shiftMonth(now, -1)] },
  { label: "Last 3 months", range: (now) => [shiftMonth(now, -2), now] },
  { label: "Last 6 months", range: (now) => [shiftMonth(now, -5), now] },
  { label: "Last 12 months", range: (now) => [shiftMonth(now, -11), now] },
  { label: "Year to date", range: (now) => [`${now.slice(0, 4)}-01`, now] },
];

export function MonthRangePicker({ fromMonth, toMonth }: { fromMonth: string; toMonth: string }) {
  const [open, setOpen] = useState(false);
  const [customFrom, setCustomFrom] = useState(fromMonth);
  const [customTo, setCustomTo] = useState(toMonth);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    setCustomFrom(fromMonth);
    setCustomTo(toMonth);
  }, [fromMonth, toMonth]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  function apply(from: string, to: string) {
    // Swap if the user picked backwards — never silently produce an
    // inverted (empty) range.
    const [a, b] = from <= to ? [from, to] : [to, from];
    const params = new URLSearchParams(searchParams.toString());
    params.set("fromMonth", a);
    params.set("toMonth", b);
    // push() only, no refresh() — same reasoning DateRangePicker.tsx's own
    // apply() documents: every range change is a new querystring, always a
    // cache miss, so Next already fetches fresh data for it.
    router.push(`${pathname}?${params.toString()}`);
    setOpen(false);
  }

  const now = currentYm();
  const label = fromMonth === toMonth ? fromMonth : `${fromMonth} – ${toMonth}`;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="border border-line bg-surface px-3 py-1.5 text-[13px] text-ink-2"
      >
        {label}
      </button>

      {open && (
        <div className="absolute right-0 z-10 mt-1 flex w-[320px] border border-line bg-surface shadow-lg">
          <ul className="w-[150px] border-r border-line-soft py-2">
            {PRESETS.map((p) => (
              <li key={p.label}>
                <button
                  className="w-full px-3 py-1.5 text-left text-[13px] text-ink-2 hover:bg-surface-2"
                  onClick={() => {
                    const [a, b] = p.range(now);
                    apply(a, b);
                  }}
                >
                  {p.label}
                </button>
              </li>
            ))}
          </ul>
          <form
            className="flex flex-1 flex-col gap-2 p-3"
            onSubmit={(e) => {
              e.preventDefault();
              apply(customFrom, customTo);
            }}
          >
            <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
              Custom range
            </span>
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
              Apply
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
