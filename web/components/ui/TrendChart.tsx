/**
 * Hand-rolled SVG line/area chart, server-rendered (no chart library, no
 * client JS) — matches the approach used in the original screen mocks.
 * Deliberately simple: this is a network-sales-over-time sparkline, not a
 * general-purpose charting component.
 */
type Point = { label: string; value: number };

export function TrendChart({ points, ariaLabel }: { points: Point[]; ariaLabel: string }) {
  const width = 700;
  const height = 160;
  const padTop = 12;
  const padBottom = 28;
  const plotHeight = height - padTop - padBottom;

  const max = Math.max(...points.map((p) => p.value), 1);
  const step = points.length > 1 ? width / (points.length - 1) : 0;

  const coords = points.map((p, i) => {
    const x = i * step;
    const y = padTop + plotHeight - (p.value / max) * plotHeight;
    return { x, y, ...p };
  });

  const linePath = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${coords[coords.length - 1]?.x ?? 0},${height - padBottom} L${coords[0]?.x ?? 0},${height - padBottom} Z`;

  // Show at most ~8 date labels regardless of how many points, evenly spaced.
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label={ariaLabel}>
      <defs>
        <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g stroke="var(--line-soft)" strokeWidth="1">
        <line x1="0" y1={padTop} x2={width} y2={padTop} />
        <line x1="0" y1={padTop + plotHeight / 2} x2={width} y2={padTop + plotHeight / 2} />
        <line x1="0" y1={padTop + plotHeight} x2={width} y2={padTop + plotHeight} />
      </g>
      {points.length > 0 && (
        <>
          <path d={areaPath} fill="url(#trendFill)" />
          <path d={linePath} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />
          {coords.map((c, i) =>
            i === coords.length - 1 ? (
              <circle key={i} cx={c.x} cy={c.y} r="3.5" fill="var(--accent)" />
            ) : null
          )}
        </>
      )}
      <g fontSize="9" fill="var(--ink-3)" fontFamily="ui-monospace,monospace" textAnchor="middle">
        {coords
          .filter((_, i) => i % labelEvery === 0 || i === coords.length - 1)
          .map((c, i) => (
            <text key={i} x={c.x} y={height - 8}>
              {c.label}
            </text>
          ))}
      </g>
    </svg>
  );
}
