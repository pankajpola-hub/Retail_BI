"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  HistogramSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import {
  ChartSrSummary,
  ChartTooltip,
  INR_PRICE_FORMAT,
  ResetZoomButton,
  chartBaseOptions,
  inr,
  readChartPalette,
  useThemeVersion,
  type ChartPalette,
} from "./chartBase";

type HourPoint = { hour: number; value: number };

const HOUR_LABEL = (h: number) => {
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${period}`;
};

/**
 * Net sales by hour of day.
 *
 * 2026-08-15: hand-rolled SVG bars -> Tremor BarChart.
 * 2026-08-29: Tremor -> lightweight-charts (zoom/pan; see chartBase.tsx).
 * External contract unchanged: points/ariaLabel/startHour/endHour, still
 * defaulting to 9am–11pm because stores aren't open overnight.
 *
 * THE X AXIS HERE IS NOT A CALENDAR. There is no real date in this data —
 * these are hour-of-day buckets. lightweight-charts still needs a
 * chronological time per point, so each hour is mapped to a synthetic UTC
 * timestamp on one arbitrary fixed reference day (2000-01-01 + hour*3600s).
 * A tickMarkFormatter and a matching localization.timeFormatter render those
 * back as "9AM"/"12PM"/"5PM", so nothing ever displays the fake date. The
 * zoom stays genuinely meaningful — you can zoom into just the 12pm–6pm peak
 * — it just isn't pretending to be a timeline.
 */
const HOUR_BASE = Date.UTC(2000, 0, 1) / 1000;
const hourToTime = (h: number) => (HOUR_BASE + h * 3600) as UTCTimestamp;
const timeToHour = (t: Time) => Math.round((Number(t) - HOUR_BASE) / 3600);

function seriesColors(p: ChartPalette) {
  return {
    // Single-series, so grey not green — same monochrome reasoning as
    // TrendChart.tsx, now against the real --ink-3 token.
    color: p.ink3,
    base: 0,
    priceLineVisible: false,
    lastValueVisible: false,
    priceFormat: INR_PRICE_FORMAT,
  };
}

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
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const fittedRef = useRef<string | null>(null);
  const themeVersion = useThemeVersion();
  const [tip, setTip] = useState<{ x: number; y: number; title: string; value: number } | null>(null);

  const hours = useMemo(
    () => Array.from({ length: Math.max(endHour - startHour + 1, 0) }, (_, i) => startHour + i),
    [startHour, endHour]
  );
  const data = useMemo(() => {
    const byHour = new Map(points.map((p) => [p.hour, p.value]));
    return hours.map((h) => ({ time: hourToTime(h), value: byHour.get(h) ?? 0 }));
  }, [points, hours]);

  const domainKey = `${startHour}-${endHour}`;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const palette = readChartPalette();
    const chart = createChart(el, {
      ...chartBaseOptions(palette),
      timeScale: {
        ...chartBaseOptions(palette).timeScale,
        timeVisible: true,
        secondsVisible: false,
        // Hour-of-day labels instead of the synthetic reference date.
        tickMarkFormatter: (time: Time) => HOUR_LABEL(timeToHour(time)),
      },
      localization: {
        ...chartBaseOptions(palette).localization,
        // Same for the crosshair's time label.
        timeFormatter: (time: Time) => HOUR_LABEL(timeToHour(time)),
      },
    });
    const series = chart.addSeries(HistogramSeries, seriesColors(palette));
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
      setTip({
        x: param.point.x,
        y: param.point.y,
        title: HOUR_LABEL(timeToHour(param.time)),
        value: d.value,
      });
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

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;
    series.setData(data);
    // Refit only when the hour window itself changed; a value-only refresh
    // keeps whatever the user has zoomed into.
    if (fittedRef.current !== domainKey) {
      fittedRef.current = domainKey;
      chart.timeScale().fitContent();
    }
  }, [data, domainKey]);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;
    const palette = readChartPalette();
    const base = chartBaseOptions(palette);
    chart.applyOptions({
      ...base,
      timeScale: { ...base.timeScale, timeVisible: true, secondsVisible: false },
    });
    series.applyOptions(seriesColors(palette));
  }, [themeVersion]);

  const reset = () => {
    chartRef.current?.timeScale().fitContent();
    chartRef.current?.priceScale("right").applyOptions({ autoScale: true });
  };

  return (
    <div role="group" aria-label={ariaLabel} className="relative">
      <ChartSrSummary
        ariaLabel={ariaLabel}
        rows={data.map((d) => `${HOUR_LABEL(timeToHour(d.time))}: ${inr(d.value)}`)}
      />
      <ResetZoomButton onClick={reset} />
      <div ref={containerRef} className="h-36 w-full" aria-hidden />
      {tip && (
        <ChartTooltip
          x={tip.x}
          y={tip.y}
          width={containerRef.current?.clientWidth ?? 0}
          title={tip.title}
          rows={[{ value: tip.value }]}
        />
      )}
    </div>
  );
}
