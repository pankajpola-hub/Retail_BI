import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { HourlyBarChart } from "@/components/ui/HourlyBarChart";
import { NO_SCHEME } from "@/lib/sales/lineAggregates";

const INR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/**
 * Compact in-table delta — the row-level counterpart to DeltaBadge, which is
 * shaped for a KPI card (block layout, its own top margin, a baseline caption)
 * and reads wrong inside a table cell.
 *
 * Same conventions as DeltaBadge, deliberately: percent change against the
 * comparison value, and a trend GLYPH alongside the colour rather than colour
 * alone — this page's stated accessibility rule, so the direction survives for
 * a red/green-colourblind reader and in a greyscale print.
 *
 * A zero baseline has no percentage (x/0 is not "infinite growth", it is a
 * different question), so it renders as a dash rather than a fabricated number.
 */
export function InlineDelta({ current, previous, invert = false }: { current: number; previous: number; invert?: boolean }) {
  if (previous === 0) return <span className="text-ink-3">—</span>;
  const delta = ((current - previous) / Math.abs(previous)) * 100;
  const up = delta > 0.05;
  const down = delta < -0.05;
  const good = invert ? down : up;
  const bad = invert ? up : down;
  const tone = good ? "text-good" : bad ? "text-crit" : "text-ink-3";
  const Icon = up ? TrendingUp : down ? TrendingDown : Minus;
  return (
    <span className={`inline-flex items-center justify-end gap-1 whitespace-nowrap ${tone}`}>
      <Icon className="h-3 w-3" aria-hidden />
      {delta > 0 ? "+" : ""}
      {delta.toFixed(1)}%
    </span>
  );
}

/**
 * Scheme penetration bars — the same shape the section always had (one bar per
 * scheme group, width relative to the largest group's units), plus a
 * comparison column when a comparison period is set.
 *
 * The bar width still scales against the CURRENT period's own max, not a
 * combined max across both periods: the bar answers "how big is this scheme
 * relative to the others right now", and the comparison answers "which way is
 * it moving". Blending the two would make every bar shrink whenever the
 * comparison period happened to be bigger, which reads as a decline in the
 * current period that did not happen.
 */
export function SchemePenetrationBars({
  rows,
  maxQty,
  compareRows,
}: {
  rows: [string, { qty: number; net: number }][];
  maxQty: number;
  compareRows: [string, { qty: number; net: number }][] | null;
}) {
  const compareByGroup = new Map(compareRows ?? []);

  if (rows.length === 0) return <p className="text-sm text-ink-3">No scheme data in this window.</p>;

  return (
    <div className="flex flex-col gap-2">
      {rows.map(([group, v]) => {
        const prev = compareByGroup.get(group);
        return (
          <div
            key={group}
            className={`grid items-center gap-3 text-[12.5px] ${compareRows ? "grid-cols-[140px_1fr_auto_74px]" : "grid-cols-[140px_1fr_auto]"}`}
          >
            <span className={`truncate ${group === NO_SCHEME ? "text-ink-3" : ""}`}>{group}</span>
            <span className="h-4 overflow-hidden bg-surface-2">
              <span className="block h-full bg-accent" style={{ width: `${Math.max(2, (v.qty / maxQty) * 100)}%` }} />
            </span>
            <span className="whitespace-nowrap font-mono text-ink-2">
              {v.qty} units · {INR(v.net)}
            </span>
            {compareRows && (
              <span className="text-right font-mono text-[11.5px]">
                {prev ? <InlineDelta current={v.qty} previous={prev.qty} /> : <span className="text-ink-3">new</span>}
              </span>
            )}
          </div>
        );
      })}
      {compareRows && (
        <p className="mt-1 text-[11px] text-ink-3">Delta is units sold vs the comparison period. &quot;new&quot; = the scheme had no bills in that period.</p>
      )}
    </div>
  );
}

/**
 * Hour-of-day net sales, with the comparison period shown as a per-hour table
 * beneath the bars rather than as a second overlaid series.
 *
 * Two overlaid bar series at 15 hourly buckets is a chart people misread —
 * the bars either interleave (and the shape of the day, which is the whole
 * point of this chart, stops being legible) or overlap (and one period hides
 * the other). The bars keep answering "when does this store trade", and the
 * table answers "and how does that compare", which is the same split the
 * store league and scheme displays use.
 */
export function HourlyWithComparison({
  points,
  comparePoints,
  ariaLabel,
}: {
  points: { hour: number; value: number }[];
  comparePoints: { hour: number; value: number }[] | null;
  ariaLabel: string;
}) {
  if (points.length === 0 && (!comparePoints || comparePoints.length === 0)) {
    return <p className="py-8 text-center text-sm text-ink-3">No hourly sales data in this window.</p>;
  }

  const compareByHour = new Map((comparePoints ?? []).map((p) => [p.hour, p.value]));
  const hours = [...new Set([...points.map((p) => p.hour), ...(comparePoints ?? []).map((p) => p.hour)])].sort((a, b) => a - b);
  const hourLabel = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? "am" : "pm"}`;

  return (
    <>
      <HourlyBarChart points={points} ariaLabel={ariaLabel} />
      {comparePoints && (
        <div className="mt-3 overflow-x-auto border border-line-soft">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-b border-line-soft bg-surface-2 text-left text-[10px] uppercase tracking-wide text-ink-3">
                <th className="px-3 py-1.5">Hour</th>
                <th className="px-3 py-1.5 text-right">Net</th>
                <th className="px-3 py-1.5 text-right">Comparison</th>
                <th className="px-3 py-1.5 text-right">Δ</th>
              </tr>
            </thead>
            <tbody>
              {hours.map((h) => {
                const cur = points.find((p) => p.hour === h)?.value ?? 0;
                const prev = compareByHour.get(h) ?? 0;
                return (
                  <tr key={h} className="border-b border-line-soft last:border-0">
                    <td className="px-3 py-1.5">{hourLabel(h)}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{INR(cur)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-ink-3">{INR(prev)}</td>
                    <td className="px-3 py-1.5 text-right font-mono">
                      <InlineDelta current={cur} previous={prev} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/**
 * Per-store net-sales comparison, rendered BESIDE the existing faceted store
 * league rather than as a column inside it.
 *
 * StoreLeagueFacetedContent and the StoreLeagueDrilldown grid underneath it
 * are shared with /network and the Workspace Builder. Threading a comparison
 * column through them to serve one section of one page would change a
 * component two other callers depend on, for a figure only this block has.
 * The league keeps every feature it has (facets, search, saved views,
 * click-through to a store's own trend) and the comparison is stated next to
 * it — no shared component is touched.
 */
export function StoreLeagueComparison({
  current,
  comparison,
}: {
  current: { storeId: string; name: string; net: number }[];
  comparison: { storeId: string; name: string; net: number }[];
}) {
  const prevByStore = new Map(comparison.map((r) => [r.storeId, r.net]));
  if (current.length === 0) return null;

  return (
    <div className="mt-3 overflow-x-auto border border-line-soft">
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="border-b border-line-soft bg-surface-2 text-left text-[10px] uppercase tracking-wide text-ink-3">
            <th className="px-3 py-1.5">Store</th>
            <th className="px-3 py-1.5 text-right">Net</th>
            <th className="px-3 py-1.5 text-right">Comparison</th>
            <th className="px-3 py-1.5 text-right">Δ</th>
          </tr>
        </thead>
        <tbody>
          {current.map((r) => {
            const prev = prevByStore.get(r.storeId) ?? 0;
            return (
              <tr key={r.storeId} className="border-b border-line-soft last:border-0">
                <td className="px-3 py-1.5">{r.name}</td>
                <td className="px-3 py-1.5 text-right font-mono">{INR(r.net)}</td>
                <td className="px-3 py-1.5 text-right font-mono text-ink-3">{INR(prev)}</td>
                <td className="px-3 py-1.5 text-right font-mono">
                  <InlineDelta current={r.net} previous={prev} />
                </td>
              </tr>
            );
          })}
        </tbody>
        {/* Σnet / Σnet — the network delta is recomputed from the two totals,
            never an average of the per-store percentages above it. */}
        <tfoot>
          <tr className="border-t-2 border-line bg-surface-2 font-bold">
            <td className="px-3 py-1.5">Total</td>
            <td className="px-3 py-1.5 text-right font-mono">{INR(current.reduce((s, r) => s + r.net, 0))}</td>
            <td className="px-3 py-1.5 text-right font-mono text-ink-3">{INR(comparison.reduce((s, r) => s + r.net, 0))}</td>
            <td className="px-3 py-1.5 text-right font-mono">
              <InlineDelta
                current={current.reduce((s, r) => s + r.net, 0)}
                previous={comparison.reduce((s, r) => s + r.net, 0)}
              />
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
