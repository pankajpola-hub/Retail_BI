"use client";

import { AreaChart } from "@tremor/react";

/**
 * Real chart library (Tremor/Recharts under the hood) as of 2026-08-15,
 * replacing a hand-rolled SVG sparkline — same reasoning as
 * HourlyBarChart.tsx. Deliberately kept to the EXACT same external
 * contract (`points: {label,value}[]`, `ariaLabel`) as the hand-rolled
 * version it replaces, so every caller across the app (Network's
 * SalesSection, the Workspace's SalesTrendChart component, the Phase 8
 * store drilldown panel) needed zero changes — this is a pure presentation
 * swap, no data or business logic touched.
 */
type Point = { label: string; value: number };

const inr = (v: number) => `₹${Math.round(v).toLocaleString("en-IN")}`;

export function TrendChart({ points, ariaLabel }: { points: Point[]; ariaLabel: string }) {
  const data = points.map((p) => ({ date: p.label, "Net sales": p.value }));

  return (
    <div role="img" aria-label={ariaLabel}>
      <AreaChart
        className="h-40"
        data={data}
        index="date"
        categories={["Net sales"]}
        colors={["emerald"]}
        valueFormatter={inr}
        showLegend={false}
        showAnimation
        curveType="monotone"
        yAxisWidth={56}
      />
    </div>
  );
}
