"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
} from "lightweight-charts";
import {
  ChartSrSummary,
  ChartTooltip,
  INR_PRICE_FORMAT,
  ResetZoomButton,
  chartBaseOptions,
  inr,
  readChartPalette,
  timeAxisFor,
  useThemeVersion,
  type ChartPalette,
} from "./chartBase";

/**
 * Two-period overlay trend (Phase 4 period comparison, 2026-08-26) — solid
 * line = current range, dashed line = comparison range, with a two-item date
 * legend underneath.
 *
 * 2026-08-29: moved off Tremor/Recharts to lightweight-charts, same swap as
 * TrendChart/HourlyBarChart, for zoom/pan on both axes (see chartBase.tsx).
 * Two things got genuinely simpler rather than just ported:
 *
 *  - The dashed comparison stroke used to be a CSS rule aimed at the
 *    stroke-colour class Tremor happened to put on that Recharts layer
 *    (".cmp-trend .stroke-gray-500", plus an adjacent-sibling fallback) —
 *    i.e. guessing at another library's internal class names. LineSeries has
 *    a real lineStyle option, so that whole hack is gone.
 *  - Missing points no longer need Tremor's connectNulls: a series simply
 *    omits the indices it has no value for, and the line draws across the
 *    gap.
 *
 * ALIGNMENT IS BY POSITION, NOT BY DATE — unchanged. Point N of the
 * comparison range is drawn against point N of the current range (day 1 vs
 * day 1), the only alignment that makes sense when the two windows are
 * different lengths or start on different weekdays. The x axis is therefore
 * the CURRENT range's dates: index i of BOTH series is plotted at
 * current[i].date, so the comparison series is deliberately shifted onto the
 * current range's timeline. (If the comparison range is the longer one, the
 * overhanging indices continue one synthetic day at a time past the current
 * range's last date, purely to keep the time scale strictly ascending.) The
 * tooltip names each series, and the legend states both ranges in full.
 */
export type Point = { label: string; value: number; date?: string };

const DAY_MS = 86_400_000;

function currentColors(p: ChartPalette) {
  // Monochrome shell: the two series are told apart by the dash pattern and
  // the legend, not by hue.
  return {
    color: p.ink2,
    lineWidth: 2 as const,
    lineStyle: LineStyle.Solid,
    priceLineVisible: false,
    lastValueVisible: false,
    priceFormat: INR_PRICE_FORMAT,
  };
}

function comparisonColors(p: ChartPalette) {
  return {
    color: p.ink3,
    lineWidth: 2 as const,
    lineStyle: LineStyle.Dashed,
    priceLineVisible: false,
    lastValueVisible: false,
    priceFormat: INR_PRICE_FORMAT,
  };
}

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
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const curSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const cmpSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const labelsRef = useRef<Map<string, string>>(new Map());
  const fittedRef = useRef<string | null>(null);
  const themeVersion = useThemeVersion();
  const [tip, setTip] = useState<{
    x: number;
    y: number;
    title: string;
    cur: number | null;
    cmp: number | null;
  } | null>(null);

  const len = Math.max(current.length, comparison.length);

  // One shared positional time axis. Indices covered by the current range use
  // its real dates; any overhang past it continues day-by-day.
  const times = useMemo(() => {
    const base = timeAxisFor(current);
    const out = base.slice(0, len);
    if (out.length < len) {
      let last = out.length ? Date.parse(`${out[out.length - 1]}T00:00:00Z`) : Date.UTC(2000, 0, 1) - DAY_MS;
      for (let i = out.length; i < len; i++) {
        last += DAY_MS;
        out.push(new Date(last).toISOString().slice(0, 10));
      }
    }
    return out;
  }, [current, len]);

  const curData = useMemo(
    () =>
      current
        .slice(0, len)
        .map((p, i) => ({ time: times[i] as Time, value: p.value }))
        .filter((d) => typeof d.value === "number" && Number.isFinite(d.value)),
    [current, times, len]
  );
  const cmpData = useMemo(
    () =>
      comparison
        .slice(0, len)
        .map((p, i) => ({ time: times[i] as Time, value: p.value }))
        .filter((d) => typeof d.value === "number" && Number.isFinite(d.value)),
    [comparison, times, len]
  );

  // Tooltip title = the current range's own display label for that index,
  // falling back to the comparison range's when current is the shorter one.
  labelsRef.current = new Map(
    times.map((t, i) => [t, current[i]?.label ?? comparison[i]?.label ?? String(i + 1)])
  );

  const domainKey = times.length ? `${times[0]}|${times[times.length - 1]}|${times.length}` : "";

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const palette = readChartPalette();
    const chart = createChart(el, chartBaseOptions(palette));
    const curSeries = chart.addSeries(LineSeries, currentColors(palette));
    const cmpSeries = chart.addSeries(LineSeries, comparisonColors(palette));
    chartRef.current = chart;
    curSeriesRef.current = curSeries;
    cmpSeriesRef.current = cmpSeries;

    const onMove = (param: MouseEventParams) => {
      if (!param.time || !param.point || param.point.x < 0 || param.point.y < 0) {
        setTip(null);
        return;
      }
      const c = param.seriesData.get(curSeries) as { value?: number } | undefined;
      const p = param.seriesData.get(cmpSeries) as { value?: number } | undefined;
      if (typeof c?.value !== "number" && typeof p?.value !== "number") {
        setTip(null);
        return;
      }
      const key = String(param.time);
      setTip({
        x: param.point.x,
        y: param.point.y,
        title: labelsRef.current.get(key) ?? key,
        cur: typeof c?.value === "number" ? c.value : null,
        cmp: typeof p?.value === "number" ? p.value : null,
      });
    };
    chart.subscribeCrosshairMove(onMove);

    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      chartRef.current = null;
      curSeriesRef.current = null;
      cmpSeriesRef.current = null;
      fittedRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const curSeries = curSeriesRef.current;
    const cmpSeries = cmpSeriesRef.current;
    if (!chart || !curSeries || !cmpSeries) return;
    curSeries.setData(curData);
    cmpSeries.setData(cmpData);
    if (fittedRef.current !== domainKey) {
      fittedRef.current = domainKey;
      chart.timeScale().fitContent();
    }
  }, [curData, cmpData, domainKey]);

  useEffect(() => {
    const chart = chartRef.current;
    const curSeries = curSeriesRef.current;
    const cmpSeries = cmpSeriesRef.current;
    if (!chart || !curSeries || !cmpSeries) return;
    const palette = readChartPalette();
    chart.applyOptions(chartBaseOptions(palette));
    curSeries.applyOptions(currentColors(palette));
    cmpSeries.applyOptions(comparisonColors(palette));
  }, [themeVersion]);

  const reset = () => {
    chartRef.current?.timeScale().fitContent();
    chartRef.current?.priceScale("right").applyOptions({ autoScale: true });
  };

  return (
    <div role="group" aria-label={ariaLabel}>
      <ChartSrSummary
        ariaLabel={ariaLabel}
        rows={[
          `Current, ${from} to ${to}: ${current.map((p) => `${p.label} ${inr(p.value)}`).join(", ")}`,
          `Comparison, ${compareFrom} to ${compareTo}: ${comparison
            .map((p) => `${p.label} ${inr(p.value)}`)
            .join(", ")}`,
        ]}
      />
      <div className="relative">
        <ResetZoomButton onClick={reset} />
        <div ref={containerRef} className="h-40 w-full" aria-hidden />
        {tip && (
          <ChartTooltip
            x={tip.x}
            y={tip.y}
            width={containerRef.current?.clientWidth ?? 0}
            title={tip.title}
            rows={[
              ...(tip.cur !== null ? [{ name: "Current", value: tip.cur }] : []),
              ...(tip.cmp !== null ? [{ name: "Comparison", value: tip.cmp, dashed: true }] : []),
            ]}
          />
        )}
      </div>

      {/* Plain HTML/SVG legend, unchanged — it was never Tremor-dependent. */}
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
