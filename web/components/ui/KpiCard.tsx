/**
 * Direct port of the .kpi card from the screen mockups. One reference
 * component so the rest of the UI has a real pattern to copy rather than
 * everyone re-deriving the token usage from scratch.
 */
type KpiCardProps = {
  label: string;
  value: string;
  /**
   * Plain caption text on every existing caller. Widened to accept a node
   * too (2026-08-31, /sale-summary's KPI sparklines — components/ui/../
   * app/(ho)/sale-summary/Sparkline.tsx) so a small inline trend chart can
   * sit in the same slot rather than this component needing a THIRD "trend"
   * slot; existing string callers are unaffected.
   */
  sub?: string | React.ReactNode;
  tone?: "default" | "muted"; // "muted" = the dashed "no data yet" state from the mock
  /**
   * Optional comparison delta, rendered between the value and `sub` — in
   * practice a <DeltaBadge /> (components/ui/DeltaBadge.tsx), passed as a
   * node rather than as numbers so this component stays presentation-only
   * and knows nothing about period comparison. Undefined on every existing
   * caller, so nothing changes for them.
   */
  delta?: React.ReactNode;
};

export function KpiCard({ label, value, sub, tone = "default", delta }: KpiCardProps) {
  return (
    <div className="rounded-lg border border-line-soft bg-surface px-4 pb-4 pt-4 shadow-sm">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.11em] text-ink-3">
        {label}
      </div>
      <div
        className={`font-mono font-tabular mt-2 text-[26px] leading-none tracking-tight ${
          tone === "muted" ? "text-ink-3" : "text-ink"
        }`}
      >
        {value}
      </div>
      {delta ?? null}
      {sub ? <div className="mt-2 text-[11.5px] text-ink-3">{sub}</div> : null}
    </div>
  );
}
