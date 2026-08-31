"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AreaSeries,
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
  priceFormatWith,
  readChartPalette,
  timeAxisFor,
  useThemeVersion,
  type ChartPalette,
} from "./chartBase";

/**
 * Single-series daily net-sales trend.
 *
 * 2026-08-15: hand-rolled SVG sparkline -> Tremor/Recharts AreaChart.
 * 2026-08-29: Tremor -> TradingView's lightweight-charts, for real zoom/pan
 * on both axes (Tremor has none — see chartBase.tsx for the full rationale).
 *
 * The external contract is unchanged apart from ONE additive, optional field
 * on Point (`date`, the real ISO day), so every caller still works untouched:
 * the Sales page's "Net sales by day", Network's SalesSection, the
 * Workspace's SalesTrendChart, and the Phase 8 store/week drilldown panels.
 * `date` is optional precisely so a caller that doesn't supply it degrades to
 * evenly-spaced synthetic days rather than breaking (see timeAxisFor).
 *
 * Interaction: wheel over the plot zooms the date axis, drag inside the plot
 * pans, dragging the bottom time axis zooms X alone, dragging the right price
 * axis zooms Y alone, and the reset button returns to the full range.
 */
export type Point = { label: string; value: number; date?: string };

function seriesColors(p: ChartPalette, valueFormatter?: (v: number) => string) {
  return {
    // 2026-08-23 monochrome pass, carried over: this is a SINGLE-series
    // chart, so colour here is decoration, not meaning. --ink-3 exactly (the
    // real computed token now, no longer Tremor's approximate "zinc"), with a
    // faint fill. Semantic red/green stays on deltas and badges.
    // `p.series ||` is inert in light and dark — neither defines
    // --chart-series, so this is p.ink3 exactly as before. Only the opt-in
    // electro theme sets it (to its neon accent). See chartBase.tsx.
    lineColor: p.series || p.ink3,
    topColor: `${p.series || p.ink3}33`,
    bottomColor: `${p.series || p.ink3}05`,
    lineWidth: 2 as const,
    priceLineVisible: false,
    lastValueVisible: false,
    priceFormat: valueFormatter ? priceFormatWith(valueFormatter) : INR_PRICE_FORMAT,
  };
}

/**
 * `valueFormatter` — optional, defaults to the app-wide `inr` (₹ + en-IN
 * comma grouping) everywhere except /sale-summary, which passes
 * lib/saleSummary/format.ts's fmtInrAbbrev so the axis/tooltip/screen-reader
 * summary all read "₹2.21 Cr" instead. Every other existing caller is
 * unaffected — this is additive and optional.
 */
export function TrendChart({ points, ariaLabel, valueFormatter }: { points: Point[]; ariaLabel: string; valueFormatter?: (v: number) => string }) {
  const fmt = valueFormatter ?? inr;
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const labelsRef = useRef<Map<string, string>>(new Map());
  const fittedRef = useRef<string | null>(null);
  const themeVersion = useThemeVersion();
  const [tip, setTip] = useState<{ x: number; y: number; title: string; value: number } | null>(null);

  const times = useMemo(() => timeAxisFor(points), [points]);
  const data = useMemo(
    () => points.map((p, i) => ({ time: times[i] as Time, value: p.value })),
    [points, times]
  );
  // Tooltip titles keep the caller's own display label (e.g. "15 Aug"), which
  // is why the label field survives alongside the new date field.
  labelsRef.current = new Map(times.map((t, i) => [t, points[i]?.label ?? t]));

  const domainKey = times.length ? `${times[0]}|${times[times.length - 1]}|${times.length}` : "";

  // Create once. Never re-created on data or theme change — recreating would
  // throw away the user's current zoom/pan, which is the entire feature.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const palette = readChartPalette();
    const chart = createChart(el, chartBaseOptions(palette, fmt));
    const series = chart.addSeries(AreaSeries, seriesColors(palette, fmt));
    chartRef.current = chart;
    seriesRef.current = series;

    const onMove = (param: MouseEventParams) => {
      if (!param.time || !param.point || param.point.x < 0 || param.point.y < 0) {
        setTip(null);
        return;
      }
      const d = param.seriesData.get(series) as { value?: number } | undefined;
      if (!d || typeof d.value !== "number") {
        setTip(null);
        return;
      }
      const key = String(param.time);
      setTip({ x: param.point.x, y: param.point.y, title: labelsRef.current.get(key) ?? key, value: d.value });
    };
    chart.subscribeCrosshairMove(onMove);

    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      fittedRef.current = null;
    };
  }, []);

  // Data updates patch the existing series. fitContent only when the date
  // domain itself changed (grain toggle, new filter/date range) — a refresh
  // that only moves the values leaves the user's zoom exactly where it was.
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;
    series.setData(data);
    if (fittedRef.current !== domainKey) {
      fittedRef.current = domainKey;
      chart.timeScale().fitContent();
    }
  }, [data, domainKey]);

  // Theme toggle: re-read the live CSS custom properties and patch options.
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;
    const palette = readChartPalette();
    chart.applyOptions(chartBaseOptions(palette, fmt));
    series.applyOptions(seriesColors(palette, fmt));
  }, [themeVersion]);

  const reset = () => {
    chartRef.current?.timeScale().fitContent();
    chartRef.current?.priceScale("right").applyOptions({ autoScale: true });
  };

  return (
    <div role="group" aria-label={ariaLabel} className="relative">
      <ChartSrSummary ariaLabel={ariaLabel} rows={points.map((p) => `${p.label}: ${fmt(p.value)}`)} />
      <ResetZoomButton onClick={reset} />
      <div ref={containerRef} className="h-40 w-full" aria-hidden />
      {tip && (
        <ChartTooltip
          x={tip.x}
          y={tip.y}
          width={containerRef.current?.clientWidth ?? 0}
          title={tip.title}
          rows={[{ value: tip.value }]}
          valueFormatter={fmt}
        />
      )}
    </div>
  );
}
