/**
 * Direct port of the .kpi card from the screen mockups. One reference
 * component so the rest of the UI has a real pattern to copy rather than
 * everyone re-deriving the token usage from scratch.
 */
type KpiCardProps = {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "muted"; // "muted" = the dashed "no data yet" state from the mock
};

export function KpiCard({ label, value, sub, tone = "default" }: KpiCardProps) {
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
      {sub ? <div className="mt-2 text-[11.5px] text-ink-3">{sub}</div> : null}
    </div>
  );
}
