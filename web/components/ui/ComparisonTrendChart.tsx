"use client";

import { LineChart } from "@tremor/react";

/**
 * Two-period overlay trend (Phase 4 period comparison, 2026-08-26) — solid
 * line = current range, dotted line = comparison range, with a two-item date
 * legend underneath.
 *
 * Same charting library as the single-series TrendChart it stands in for
 * (Tremor/Recharts, already a dependency) — deliberately NOT a second chart
 * stack. Tremor's LineChart has no per-series dash option, so the dotted
 * comparison stroke is applied via one CSS rule against the stroke-colour
 * class Tremor itself puts on that series' Recharts layer
 * (getColorClassNames(color, colorPalette.text).strokeColor → e.g.
 * "stroke-gray-500", already in tailwind.config.ts's Tremor safelist). The
 * adjacent-sibling rule beside it is a belt-and-braces fallback: the two
 * series render as consecutive `.recharts-line` layers, so "the second one"
 * is dashed even if Tremor ever changes how it names the colour class. If
 * both selectors somehow missed, the chart degrades to two solid grey lines
 * — still readable via the legend, never wrong.
 *
 * Alignment is BY POSITION, not by date: point N of the comparison range is
 * drawn against point N of the current range (day 1 vs day 1), which is the
 * only alignment that makes sense when the two windows are different lengths
 * or start on different weekdays. The x-axis is therefore labelled with the
 * CURRENT range's dates; the comparison date for each point is in the
 * tooltip's own label via its series name, and the legend states both ranges
 * in full.
 */
type Point = { label: string; value: number };

const inr = (v: number) => `₹${Math.round(v).toLocaleString("en-IN")}`;

const DASH_CSS = `
.cmp-trend .stroke-gray-500 { stroke-dasharray: 5 4; }
.cmp-trend .recharts-line + .recharts-line { stroke-dasharray: 5 4; }
`;

export function ComparisonTrendChart({
  current,
  comparison,
  from,
  to,
  compareFrom,
  compareTo,
  ariaLabel,
}: {
  current: Point[];
  comparison: Point[];
  from: string;
  to: string;
  compareFrom: string;
  compareTo: string;
  ariaLabel: string;
}) {
  const len = Math.max(current.length, comparison.length);
  const data = Array.from({ length: len }, (_, i) => {
    const c = current[i];
    const p = comparison[i];
    return {
      date: c?.label ?? p?.label ?? String(i + 1),
      Current: c?.value ?? null,
      Comparison: p?.value ?? null,
    };
  });

  return (
    <div role="img" aria-label={ariaLabel}>
      <style>{DASH_CSS}</style>
      <div className="cmp-trend">
        <LineChart
          className="h-40"
          data={data}
          index="date"
          categories={["Current", "Comparison"]}
          // Monochrome shell (see TrendChart.tsx): the two series are told
          // apart by the dash pattern and the legend, not by hue. "zinc"
          // matches the single-series chart this replaces; "gray" is the
          // class the dash rule above keys off.
          colors={["zinc", "gray"]}
          valueFormatter={inr}
          showLegend={false}
          connectNulls
          curveType="monotone"
          yAxisWidth={56}
        />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11.5px] text-ink-3">
        <span className="inline-flex items-center gap-1.5">
          <svg viewBox="0 0 20 6" className="h-1.5 w-5" aria-hidden>
            <line x1="0" y1="3" x2="20" y2="3" stroke="currentColor" strokeWidth="2" className="text-ink-2" />
          </svg>
          <span className="font-medium text-ink-2">Current</span>
          <span>
            {from} – {to}
          </span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <svg viewBox="0 0 20 6" className="h-1.5 w-5" aria-hidden>
            <line x1="0" y1="3" x2="20" y2="3" stroke="currentColor" strokeWidth="2" strokeDasharray="5 4" />
          </svg>
          <span className="font-medium">Comparison</span>
          <span>
            {compareFrom} – {compareTo}
          </span>
        </span>
      </div>
    </div>
  );
}
