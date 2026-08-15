"use client";

import { useMemo, useState } from "react";

/**
 * The single, obvious way to download sale data from the Sale report
 * section — folded into that section instead of a separate top-level
 * button (2026-08 UI consolidation). Always reads the full accumulated
 * raw_logic.sales_transactions history via /api/data-upload/download-merged
 * (sales.vw_sale_transactions_export, migration 0028/0033), never a single
 * raw uploaded file, so it stays in sync with every Process click.
 *
 * `fiscalYears` are whatever's actually present in the data right now
 * (sales.vw_sale_transactions_fiscal_years, migration 0033) — never a
 * hardcoded list. No selection = every year (the full merged file).
 */
export function MergedSaleDownload({ fiscalYears }: { fiscalYears: string[] }) {
  const [selected, setSelected] = useState<string[]>([]);

  const href = useMemo(() => {
    if (selected.length === 0) return "/api/data-upload/download-merged";
    return `/api/data-upload/download-merged?fy=${encodeURIComponent(selected.join(","))}`;
  }, [selected]);

  function toggle(fy: string) {
    setSelected((prev) => (prev.includes(fy) ? prev.filter((f) => f !== fy) : [...prev, fy]));
  }

  return (
    <li className="flex flex-col gap-2 bg-canvas-2 px-3 py-2.5 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="flex flex-col">
          <span className="font-semibold">Merged sale data (current database)</span>
          <span className="text-[11px] text-ink-3">
            Always the full, up-to-date accumulated history — not a single uploaded file.
          </span>
        </span>
        <a
          href={href}
          className="shrink-0 border border-line px-2 py-1 text-[11px] uppercase tracking-wide text-ink-2 hover:text-ink"
        >
          Download{selected.length > 0 ? ` (${selected.length} FY)` : " (all years)"}
        </a>
      </div>

      {fiscalYears.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
            Financial year (optional, select one or more):
          </span>
          {fiscalYears.map((fy) => (
            <label key={fy} className="flex items-center gap-1.5 text-[12px] text-ink-2">
              <input
                type="checkbox"
                checked={selected.includes(fy)}
                onChange={() => toggle(fy)}
                className="h-3.5 w-3.5"
              />
              {fy}
            </label>
          ))}
          {selected.length > 0 && (
            <button
              type="button"
              onClick={() => setSelected([])}
              className="text-[11px] text-ink-3 underline"
            >
              Clear
            </button>
          )}
        </div>
      )}
    </li>
  );
}
