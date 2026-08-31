"use client";

import { useState } from "react";
import type { BreakdownRow } from "@/lib/saleSummary/aggregate";
import { fmtInrAbbrev } from "@/lib/saleSummary/format";

/**
 * Channel Model / Channel Type mix — net-sales share donut (2026-08-31
 * redesign, "make the page feel alive" ask). No chart library involved:
 * chartBase.tsx's trio (TrendChart/HourlyBarChart/ComparisonTrendChart) are
 * all lightweight-charts time-series primitives with no pie/donut series
 * type at all, and pulling in a second charting library for one proportion
 * chart would be a bigger footprint than a ~40-line inline SVG arc. Colour
 * stays within this app's existing token set (--ink/--ink-2/--ink-3/
 * --accent/--good/--warn) rather than introducing a new categorical
 * palette, cycling through them for the (rare) case of more segments than
 * tones — every segment is also labeled by name in the legend, so colour is
 * never the only signal, same rule the rest of this app's charts follow.
 */
const SEGMENT_COLORS = ["var(--ink)", "var(--accent-ink)", "var(--ink-3)", "var(--good)", "var(--warn)", "var(--ink-2)", "var(--crit)"];

function buildArcs(rows: BreakdownRow[]) {
  const total = rows.reduce((s, r) => s + Math.max(r.net, 0), 0);
  if (total <= 0) return [];
  let cumulative = 0;
  const R = 42;
  const CX = 50;
  const CY = 50;
  return rows
    .map((r, i) => {
      const value = Math.max(r.net, 0);
      const share = value / total;
      const startAngle = cumulative * 2 * Math.PI - Math.PI / 2;
      cumulative += share;
      const endAngle = cumulative * 2 * Math.PI - Math.PI / 2;
      const x1 = CX + R * Math.cos(startAngle);
      const y1 = CY + R * Math.sin(startAngle);
      const x2 = CX + R * Math.cos(endAngle);
      const y2 = CY + R * Math.sin(endAngle);
      const largeArc = share > 0.5 ? 1 : 0;
      const d = share >= 0.999
        ? `M ${CX} ${CY - R} A ${R} ${R} 0 1 1 ${CX - 0.01} ${CY - R} Z`
        : `M ${CX} ${CY} L ${x1} ${y1} A ${R} ${R} 0 ${largeArc} 1 ${x2} ${y2} Z`;
      return { key: r.key, d, share, net: r.net, color: SEGMENT_COLORS[i % SEGMENT_COLORS.length]! };
    })
    .filter((a) => a.share > 0);
}

export function MixDonutChart({ modelRows, typeRows }: { modelRows: BreakdownRow[]; typeRows: BreakdownRow[] }) {
  const [view, setView] = useState<"model" | "type">("model");
  const rows = view === "model" ? modelRows : typeRows;
  const arcs = buildArcs(rows);
  const total = rows.reduce((s, r) => s + Math.max(r.net, 0), 0);

  return (
    <div className="border border-line-soft p-3">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Net sales mix</span>
        <div className="flex gap-1">
          {(["model", "type"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${
                view === v ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-ink-3 hover:text-ink-2"
              }`}
            >
              {v === "model" ? "By Channel Model" : "By Channel Type"}
            </button>
          ))}
        </div>
      </div>

      {arcs.length === 0 ? (
        <p className="py-10 text-center text-sm text-ink-3">No data in this scope.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-5">
          <svg viewBox="0 0 100 100" className="h-32 w-32 shrink-0" role="img" aria-label={`${view === "model" ? "Channel Model" : "Channel Type"} share of net sales`}>
            {arcs.map((a) => (
              <path key={a.key} d={a.d} fill={a.color} />
            ))}
            <circle cx="50" cy="50" r="24" fill="var(--surface)" />
          </svg>
          <ul className="flex-1 space-y-1 text-[12px]">
            {arcs.map((a) => (
              <li key={a.key} className="flex items-center gap-2">
                <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: a.color }} />
                <span className="flex-1 truncate text-ink-2">{a.key}</span>
                <span className="font-mono text-ink-3">{(a.share * 100).toFixed(1)}%</span>
                <span className="font-mono font-medium text-ink">{fmtInrAbbrev(a.net)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-2 text-[11px] text-ink-3">{total > 0 ? `${fmtInrAbbrev(total)} total net sales across ${arcs.length} ${view === "model" ? "channel model" : "channel type"}${arcs.length === 1 ? "" : "s"}` : ""}</p>
    </div>
  );
}
