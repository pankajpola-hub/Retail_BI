"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";

/**
 * "Compare to" range picker (Phase 4 period comparison, 2026-08-26) — sits
 * next to the existing DateRangePicker and drives ?compareFrom=&compareTo=.
 *
 * Default OFF: comparison only activates when BOTH params are present, which
 * is what keeps the doubled data-fetch conditional rather than always-on (a
 * page load with no compare params issues exactly the queries it issued
 * before this feature existed).
 *
 * Same navigation contract as DateRangePicker: push() only, no refresh() —
 * see that file's own writeup for why pairing them is actively worse.
 */
const iso = (d: Date) => d.toISOString().slice(0, 10);

function shiftDays(isoStr: string, days: number): string {
  const d = new Date(`${isoStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function shiftYears(isoStr: string, years: number): string {
  const d = new Date(`${isoStr}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}

/** Length of the current range, in days, inclusive of both ends. */
function rangeDays(from: string, to: string): number {
  return Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400000) + 1;
}

export function ComparisonDateRangePicker({
  from,
  to,
  compareFrom,
  compareTo,
}: {
  from: string;
  to: string;
  compareFrom: string | null;
  compareTo: string | null;
}) {
  const active = Boolean(compareFrom && compareTo);
  const [open, setOpen] = useState(false);
  const [customFrom, setCustomFrom] = useState(compareFrom ?? shiftDays(from, -rangeDays(from, to)));
  const [customTo, setCustomTo] = useState(compareTo ?? shiftDays(from, -1));
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Re-sync the custom inputs when the URL changes from elsewhere. push() is
  // a soft navigation so this component stays mounted and the useState
  // initialisers above run once only; `from`/`to` are in the dep list because
  // the default (uncompared) derivation is computed from the main range.
  useEffect(() => {
    setCustomFrom(compareFrom ?? shiftDays(from, -rangeDays(from, to)));
    setCustomTo(compareTo ?? shiftDays(from, -1));
  }, [compareFrom, compareTo, from, to]);

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
      params.set("compareFrom", newFrom);
      params.set("compareTo", newTo);
    } else {
      params.delete("compareFrom");
      params.delete("compareTo");
    }
    router.push(`${pathname}?${params.toString()}`);
    setOpen(false);
  }

  const days = rangeDays(from, to);
  const prevPeriod: [string, string] = [shiftDays(from, -days), shiftDays(from, -1)];
  const prevYear: [string, string] = [shiftYears(from, -1), shiftYears(to, -1)];

  const label = active ? (compareFrom === compareTo ? compareFrom! : `${compareFrom} – ${compareTo}`) : "Compare to…";

  return (
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
          <ul className="w-[150px] border-r border-line-soft py-2">
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
                Previous year
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
              Compare
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
