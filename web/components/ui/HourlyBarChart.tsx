"use client";

import { BarChart } from "@tremor/react";

type HourPoint = { hour: number; value: number };

const HOUR_LABEL = (h: number) => {
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${period}`;
};

const inr = (v: number) => `₹${Math.round(v).toLocaleString("en-IN")}`;

/**
 * Real chart library (Tremor/Recharts) as of 2026-08-15, replacing a
 * hand-rolled SVG bar chart — see TrendChart.tsx for the full rationale.
 * Same external contract as before (points/ariaLabel/startHour/endHour),
 * zero caller changes needed. Still defaults to 9am-12am — stores aren't
 * open overnight, so hours 0-8 stay dead space either way.
 */
export function HourlyBarChart({
  points,
  ariaLabel,
  startHour = 9,
  endHour = 23,
}: {
  points: HourPoint[];
  ariaLabel: string;
  startHour?: number;
  endHour?: number;
}) {
  const byHour = new Map(points.map((p) => [p.hour, p.value]));
  const hours = Array.from({ length: endHour - startHour + 1 }, (_, i) => startHour + i);
  const data = hours.map((h) => ({ hour: HOUR_LABEL(h), "Net sales": byHour.get(h) ?? 0 }));

  return (
    <div role="img" aria-label={ariaLabel}>
      <BarChart
        className="h-36"
        data={data}
        index="hour"
        categories={["Net sales"]}
        colors={["emerald"]}
        valueFormatter={inr}
        showLegend={false}
        showAnimation
        yAxisWidth={56}
      />
    </div>
  );
}
