type HourPoint = { hour: number; value: number };

const HOUR_LABEL = (h: number) => {
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${period}`;
};

/**
 * Server-rendered SVG bar chart, no client JS. Defaults to 9am–12am
 * (startHour=9, endHour=23) rather than the full 24 — stores aren't open
 * overnight, so hours 0–8 were just dead space on the chart.
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
  const width = 700;
  const height = 140;
  const padBottom = 22;
  const byHour = new Map(points.map((p) => [p.hour, p.value]));
  const hours = Array.from({ length: endHour - startHour + 1 }, (_, i) => startHour + i);
  const max = Math.max(...hours.map((h) => byHour.get(h) ?? 0), 1);
  const barWidth = width / hours.length;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label={ariaLabel}>
      <line x1="0" y1={height - padBottom} x2={width} y2={height - padBottom} stroke="var(--line-soft)" />
      {hours.map((h, i) => {
        const v = byHour.get(h) ?? 0;
        const barHeight = (v / max) * (height - padBottom - 8);
        return (
          <g key={h}>
            <rect
              x={i * barWidth + 1.5}
              y={height - padBottom - barHeight}
              width={barWidth - 3}
              height={barHeight}
              fill="var(--accent)"
              opacity={v > 0 ? 0.85 : 0.15}
            />
            {i % 2 === 0 && (
              <text
                x={i * barWidth + barWidth / 2}
                y={height - 6}
                fontSize="9"
                fill="var(--ink-3)"
                fontFamily="ui-monospace,monospace"
                textAnchor="middle"
              >
                {HOUR_LABEL(h)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
