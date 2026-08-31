/**
 * Small inline trend line for a KPI card (2026-08-31 redesign, "make the
 * page feel alive" ask). No component in this app already does this —
 * chartBase.tsx's trio are full lightweight-charts instances (zoom/pan,
 * crosshair, tooltip) meant for a dedicated chart panel, not a ~60x22px
 * glyph inside a stat card; mounting one per KPI card would be a lot of
 * canvas/JS weight for a decoration. A plain inline <svg> polyline instead —
 * server-renderable (KpiCard itself is a server component; this stays one
 * too, no "use client" needed since there's no interaction), themed via the
 * same CSS custom properties every other chart here reads.
 */
export function Sparkline({ values, tone = "muted" }: { values: number[]; tone?: "muted" | "good" | "crit" }) {
  if (values.length < 2) return null;
  const W = 64;
  const H = 22;
  const PAD = 2;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values.map((v, i) => {
    const x = PAD + (i / (values.length - 1)) * (W - PAD * 2);
    const y = H - PAD - ((v - min) / span) * (H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const color = tone === "good" ? "var(--good)" : tone === "crit" ? "var(--crit)" : "var(--ink-3)";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-1.5 h-[22px] w-16" role="img" aria-hidden>
      <polyline points={points.join(" ")} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={points[points.length - 1]!.split(",")[0]} cy={points[points.length - 1]!.split(",")[1]} r="1.6" fill={color} />
    </svg>
  );
}
