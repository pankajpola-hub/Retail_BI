"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";

type Preset = { label: string; days?: number; range?: () => [Date, Date] };

// LOCAL-date formatter, deliberately NOT toISOString(). The preset helpers
// below build local-midnight Date objects (new Date(y, m, d)); serializing
// those through toISOString() converts to UTC, which in any timezone east of
// UTC (IST = +05:30) lands on the PREVIOUS calendar day — "This month" on
// 2026-08-27 IST returned 2026-07-31 as `from`. Reading the local fields
// directly keeps the string equal to what the user sees on their calendar.
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const endOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth() + 1, 0);
const startOfQuarter = (d: Date) => new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1);

function presets(today: Date): Preset[] {
  const y = new Date(today);
  y.setDate(y.getDate() - 1);
  const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  return [
    { label: "Today", range: () => [today, today] },
    { label: "Yesterday", range: () => [y, y] },
    { label: "Last 7 days", days: 6 },
    { label: "Last 30 days", days: 29 },
    { label: "Last 90 days", days: 89 },
    { label: "This month", range: () => [startOfMonth(today), today] },
    { label: "Last month", range: () => [startOfMonth(lastMonth), endOfMonth(lastMonth)] },
    { label: "This quarter", range: () => [startOfQuarter(today), today] },
  ];
}

/**
 * Shopify-style range picker, simplified: preset list + a custom two-date
 * form, no dual-month calendar widget. Drives ?from=&to= on the current URL
 * so the page stays a normal server-rendered fetch — no client-side data
 * fetching here, just navigation.
 */
export function DateRangePicker({ from, to }: { from: string; to: string }) {
  const [open, setOpen] = useState(false);
  const [customFrom, setCustomFrom] = useState(from);
  const [customTo, setCustomTo] = useState(to);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Re-sync the custom inputs when the URL range changes from elsewhere
  // (a preset click, browser Back, a hand-edited URL). router.push() is a
  // soft navigation: this component stays mounted, so the useState
  // initialisers above run only once and would otherwise show a stale range.
  useEffect(() => {
    setCustomFrom(from);
    setCustomTo(to);
  }, [from, to]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  function apply(newFrom: string, newTo: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("from", newFrom);
    params.set("to", newTo);
    // Deliberately push() ONLY, no refresh() — see StoreFilter.tsx's
    // onChange for the full writeup. A prior version here called
    // router.refresh() right after push() (even tried wrapping both in one
    // startTransition) reasoning that push() alone risks a stale Router
    // Cache hit; in practice pairing them was worse, reproduced live on the
    // sibling StoreFilter component: refresh() doesn't target the new URL,
    // it just refetches whatever route the router currently considers
    // active, and calling it right after push() can act on the OLD route
    // before the navigation commits — network trace showed the new URL's
    // RSC fetch actually succeeding, then the committed URL silently
    // reverting anyway. push() alone is sufficient: every date-range change
    // produces a new ?from=&to=, always a cache miss, so Next already
    // fetches fresh data for it.
    router.push(`${pathname}?${params.toString()}`);
    setOpen(false);
  }

  const today = new Date();
  const label = from === to ? from : `${from} – ${to}`;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="border border-line bg-surface px-3 py-1.5 text-[13px] text-ink-2"
      >
        {label}
      </button>

      {open && (
        <div className="absolute right-0 z-10 mt-1 flex w-[340px] border border-line bg-surface shadow-lg">
          <ul className="w-[150px] border-r border-line-soft py-2">
            {presets(today).map((p) => (
              <li key={p.label}>
                <button
                  className="w-full px-3 py-1.5 text-left text-[13px] text-ink-2 hover:bg-surface-2"
                  onClick={() => {
                    if (p.range) {
                      const [a, b] = p.range();
                      apply(iso(a), iso(b));
                    } else if (p.days !== undefined) {
                      const start = new Date(today);
                      start.setDate(start.getDate() - p.days);
                      apply(iso(start), iso(today));
                    }
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
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="border border-line px-2 py-1 text-[13px]"
              />
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-ink-2">
              To
              <input
                type="date"
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
