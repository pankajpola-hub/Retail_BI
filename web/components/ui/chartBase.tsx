"use client";

import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import {
  ColorType,
  CrosshairMode,
  LineStyle,
  type ChartOptions,
  type DeepPartial,
} from "lightweight-charts";

/**
 * Shared plumbing for the three lightweight-charts components in this folder
 * (TrendChart, HourlyBarChart, ComparisonTrendChart), added 2026-08-29 when
 * they moved off Tremor/Recharts.
 *
 * WHY THE MOVE: Tremor's charts have no zoom or pan at all — its
 * BaseChartProps has no option for it and Recharts' own brush is a separate,
 * single-axis widget. The ask was "professional, like a stock-trading site",
 * i.e. wheel-zoom, drag-pan, and independent zoom on BOTH axes.
 * lightweight-charts (TradingView's own, Apache-2.0, canvas) ships all of
 * that switched ON by default — handleScroll/handleScale — so this is a
 * library swap, not hand-written drag maths.
 *
 * Everything here is presentation only. No business logic moved.
 */

/** Same helper the three chart files each had locally, hoisted so they agree. */
export const inr = (v: number) => `₹${Math.round(v).toLocaleString("en-IN")}`;

export type ChartPalette = {
  ink: string;
  ink2: string;
  ink3: string;
  line: string;
  lineSoft: string;
  surface: string;
  /**
   * Optional override for the SERIES stroke only (not axes, grid or text).
   * EMPTY STRING in light and dark — neither theme defines --chart-series, so
   * every caller falls back to the muted ink it already used and those two
   * themes render pixel-identically to before this token existed.
   *
   * The opt-in electro theme sets it to its neon accent, because a monochrome
   * grey trend line is the one thing that made that theme read as "dark mode
   * with a green button" rather than the trading-terminal reference it's
   * modelled on. Deliberately a SEPARATE token rather than reusing --accent:
   * --accent is near-black in light and near-white in dark, so binding the
   * series to it would silently restyle the charts in both shipped themes.
   */
  series: string;
};

/**
 * Light-mode values from globals.css :root, used only if a custom property
 * somehow reads back empty (SSR, or the very first paint in a test env).
 * Unlike DataGrid.tsx — which has to pin BOTH palettes as literals because AG
 * Grid evaluates its theme in JS and can't see CSS variables — a canvas chart
 * is configured at runtime in the browser, so we can read the live computed
 * values and never drift from globals.css.
 */
const FALLBACK: ChartPalette = {
  ink: "#111113",
  ink2: "#46464b",
  ink3: "#6b6b72",
  line: "#d2d2d5",
  lineSoft: "#e6e6e8",
  surface: "#ffffff",
  series: "",
};

export function readChartPalette(): ChartPalette {
  if (typeof window === "undefined") return FALLBACK;
  const cs = getComputedStyle(document.documentElement);
  const pick = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
  return {
    ink: pick("--ink", FALLBACK.ink),
    ink2: pick("--ink-2", FALLBACK.ink2),
    ink3: pick("--ink-3", FALLBACK.ink3),
    line: pick("--line", FALLBACK.line),
    lineSoft: pick("--line-soft", FALLBACK.lineSoft),
    surface: pick("--surface", FALLBACK.surface),
    // No fallback hex on purpose — an unset custom property must stay empty
    // so callers can do `p.series || p.ink3` and keep their old colour.
    series: cs.getPropertyValue("--chart-series").trim(),
  };
}

/**
 * Bumps a counter whenever <html data-theme> changes. Same MutationObserver
 * idiom as DataGrid.tsx's useIsDarkTheme — a component elsewhere in the tree
 * doesn't own the attribute, so it has to observe it. A counter rather than a
 * boolean because the charts don't branch on light/dark themselves: they just
 * re-read the computed palette and re-apply it, which keeps this working if a
 * third theme is ever added.
 */
export function useThemeVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setVersion((v) => v + 1));
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return version;
}

/**
 * Chart options shared by all three charts. Re-applied wholesale on theme
 * change via chart.applyOptions(), which does NOT reset the user's current
 * zoom/pan — that is the whole reason the chart is created once and only ever
 * patched afterwards.
 *
 * handleScroll/handleScale are left at their defaults (true) deliberately:
 * wheel over the plot = zoom X, drag in the plot = pan, drag the bottom time
 * axis = zoom X only, drag the right price axis = zoom Y only.
 */
export function chartBaseOptions(p: ChartPalette): DeepPartial<ChartOptions> {
  return {
    layout: {
      background: { type: ColorType.Solid, color: p.surface },
      textColor: p.ink3,
      fontSize: 11,
      fontFamily: "inherit",
      // The default TradingView watermark badge would read as a third-party
      // widget bolted into an otherwise monochrome shell. Attribution lives
      // in package.json / LICENSE instead; Apache-2.0 does not require it
      // on-screen.
      attributionLogo: false,
    },
    grid: {
      horzLines: { color: p.lineSoft },
      // Tremor drew no vertical gridlines either; keeping them off preserves
      // the previous visual density.
      vertLines: { visible: false },
    },
    crosshair: {
      // Normal (not Magnet) — a free crosshair is what a trading chart does,
      // and the tooltip below still snaps its readout to the hovered point.
      mode: CrosshairMode.Normal,
      vertLine: { color: p.line, style: LineStyle.Dashed, labelBackgroundColor: p.ink },
      horzLine: { color: p.line, style: LineStyle.Dashed, labelBackgroundColor: p.ink },
    },
    rightPriceScale: {
      borderColor: p.lineSoft,
      scaleMargins: { top: 0.12, bottom: 0.08 },
    },
    timeScale: {
      borderColor: p.lineSoft,
      // A dashboard range is finite: don't let the user pan off into empty
      // space either side of the data.
      fixLeftEdge: true,
      fixRightEdge: true,
      rightOffset: 0,
    },
    localization: {
      locale: "en-IN",
      // ₹ + en-IN grouping on the price axis and the crosshair price label,
      // matching every other money figure in the app.
      priceFormatter: inr,
    },
    autoSize: true,
  };
}

/** Custom price format so the series' own axis labels are ₹-formatted too. */
export const INR_PRICE_FORMAT = {
  type: "custom" as const,
  formatter: inr,
  minMove: 1,
};

/**
 * Maps points to strictly-ascending 'YYYY-MM-DD' business days for the time
 * scale. Prefers each point's real ISO date (added to the producers in
 * lib/sales/aggregate.ts and the sales page); falls back to one synthetic day
 * per index so a caller that predates the widened Point type still renders a
 * sane, evenly-spaced chart instead of throwing. Also repairs unsorted or
 * duplicated dates, because setData() requires ascending unique times.
 */
const SYNTHETIC_EPOCH = Date.UTC(2000, 0, 1);
const DAY_MS = 86_400_000;

export function timeAxisFor(points: { date?: string }[]): string[] {
  const out: string[] = [];
  let prev: number | null = null;
  points.forEach((p, i) => {
    let t = p.date && /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? Date.parse(`${p.date}T00:00:00Z`) : NaN;
    if (!Number.isFinite(t)) t = SYNTHETIC_EPOCH + i * DAY_MS;
    if (prev !== null && t <= prev) t = prev + DAY_MS;
    prev = t;
    out.push(new Date(t).toISOString().slice(0, 10));
  });
  return out;
}

/**
 * Small ghost icon button, house style (see components/ui/button.tsx's ghost
 * variant + size="icon"; authored inline rather than via <Button> so it can
 * sit absolutely inside the chart frame without fighting the min-height
 * variants). Returns the view to the full data range.
 */
export function ResetZoomButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Reset zoom"
      aria-label="Reset zoom"
      className="absolute right-1 top-1 z-10 inline-flex h-6 w-6 items-center justify-center rounded-md text-ink-3 opacity-60 transition-colors hover:bg-surface-2 hover:text-ink-2 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <RotateCcw className="h-3.5 w-3.5" aria-hidden />
    </button>
  );
}

export type TooltipRow = { name?: string; value: number; dashed?: boolean };

/**
 * lightweight-charts has no built-in tooltip (Tremor did), so this is the
 * documented pattern: an absolutely-positioned HTML overlay fed by
 * subscribeCrosshairMove. Visual language copied from the app's existing
 * popovers (FacetFilterBar's dropdown: rounded-md, border-line, bg-surface,
 * shadow-lg) at the 11.5px size the comparison legend already uses.
 */
export function ChartTooltip({
  x,
  y,
  width,
  title,
  rows,
}: {
  x: number;
  y: number;
  width: number;
  title: string;
  rows: TooltipRow[];
}) {
  const TIP_W = 150;
  const left = Math.min(Math.max(x + 12, 4), Math.max(width - TIP_W - 4, 4));
  return (
    <div
      className="pointer-events-none absolute z-20 w-[150px] rounded-md border border-line bg-surface p-2 text-[11.5px] shadow-lg"
      style={{ left, top: Math.max(y - 8, 4) }}
    >
      <div className="font-medium text-ink">{title}</div>
      <div className="mt-1 space-y-0.5">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center justify-between gap-2 text-ink-3">
            {r.name && (
              <span className="inline-flex items-center gap-1.5">
                <svg viewBox="0 0 20 6" className="h-1.5 w-4" aria-hidden>
                  <line
                    x1="0"
                    y1="3"
                    x2="20"
                    y2="3"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeDasharray={r.dashed ? "5 4" : undefined}
                  />
                </svg>
                {r.name}
              </span>
            )}
            <span className="ml-auto tabular-nums font-medium text-ink-2">{inr(r.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Screen-reader fallback. The old wrapper was role="img" + aria-label, which
 * is no longer accurate now the chart is genuinely interactive (a canvas you
 * can zoom and pan is not an image), and it never exposed the numbers anyway.
 * These charts are now role="group" + the same aria-label, with the series
 * read out as text here — strictly more accessible than before, and the
 * canvas itself is aria-hidden so a screen reader isn't offered an opaque,
 * unlabelled element.
 */
export function ChartSrSummary({ ariaLabel, rows }: { ariaLabel: string; rows: string[] }) {
  return (
    <p className="sr-only">
      {ariaLabel}. {rows.join(". ")}.
    </p>
  );
}
