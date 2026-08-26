import { TrendingUp, TrendingDown, Minus } from "lucide-react";

/**
 * Period-comparison delta badge (Phase 4, 2026-08-26) — the "+12.4% vs
 * comparison period" chip that sits under a KpiCard's value once a
 * comparison range is active.
 *
 * Deliberately NOT a client component: every caller is a Server Component
 * that already has both numbers in hand, so this renders on the server like
 * KpiCard itself. Colour uses the app's existing --good/--crit tokens (the
 * only colour the monochrome shell still allows, and only on data), plus a
 * TrendingUp/TrendingDown glyph so direction reads without relying on colour
 * alone — the same second-signal rule the WoW cells on this page follow.
 */

/** Percent change, null when the baseline is zero/absent (a change from 0 has no meaningful %). */
export function pctDelta(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

export type DeltaBadgeProps = {
  current: number | null;
  previous: number | null;
  /**
   * "pct"  — relative change, the default (money, counts).
   * "pp"   — percentage POINTS, for metrics that are themselves a percentage
   *          (discount %). A discount rate moving 18% → 20% is +2.0pp, not
   *          +11.1% — showing the latter is the classic ratio-of-ratios lie.
   */
  mode?: "pct" | "pp";
  /** true when "up" is bad (discount given, cancellations) — flips good/crit only, never the arrow. */
  invert?: boolean;
  /** Rendered after the delta, e.g. "vs ₹12,45,000". */
  baselineLabel?: string;
};

export function DeltaBadge({ current, previous, mode = "pct", invert = false, baselineLabel }: DeltaBadgeProps) {
  const hasBoth = current !== null && previous !== null;
  const delta = !hasBoth ? null : mode === "pp" ? current - previous : pctDelta(current, previous);

  if (delta === null) {
    return (
      <div className="mt-2 flex items-center gap-1 text-[11.5px] text-ink-3">
        <Minus className="h-3 w-3" />
        <span>no comparison baseline</span>
      </div>
    );
  }

  const up = delta > 0.05;
  const down = delta < -0.05;
  const good = invert ? down : up;
  const bad = invert ? up : down;
  const tone = good ? "text-good" : bad ? "text-crit" : "text-ink-3";
  const Icon = up ? TrendingUp : down ? TrendingDown : Minus;
  const sign = delta > 0 ? "+" : "";
  const text = mode === "pp" ? `${sign}${delta.toFixed(1)}pp` : `${sign}${delta.toFixed(1)}%`;

  return (
    <div className={`mt-2 flex flex-wrap items-center gap-1 text-[11.5px] ${tone}`}>
      <Icon className="h-3 w-3 shrink-0" />
      <span className="font-mono font-semibold">{text}</span>
      <span className="text-ink-3">{baselineLabel ?? "vs comparison period"}</span>
    </div>
  );
}
