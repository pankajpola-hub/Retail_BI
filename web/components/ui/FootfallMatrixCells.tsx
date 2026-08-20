import { Pill } from "@/components/ui/Pill";
import {
  QUADRANT_AXES,
  TRAFFIC_SALES_META,
  trafficSalesQuadrant,
  type Quadrant,
  type TrafficSalesQuadrant,
  type MatrixEntry,
} from "@/lib/network/footfall";

/**
 * The two quadrant-grid cell renderers `/network`'s FootfallSection uses for
 * its Footfall x Conversion and Traffic vs Sales matrices — extracted
 * verbatim (2026-08-20) alongside lib/network/footfall.ts so the Workspace
 * Builder's `footfall_conversion_matrix`/`traffic_sales_matrix` components
 * render the SAME cell markup, not a hand-resynced copy. Presentation-only
 * (no business logic here beyond the trafficSalesQuadrant() bucketing import
 * from footfall.ts), but drift in colors/thresholds between two copies would
 * still be a real "two places disagree" bug, so this gets the same
 * single-source treatment as the classification logic itself.
 */

const INR_SHORT = (n: number) => (n >= 100000 ? `₹${(n / 100000).toFixed(2)}L` : `₹${Math.round(n).toLocaleString("en-IN")}`);

export function MatrixCell({ quadrant, entries }: { quadrant: Quadrant; entries: MatrixEntry[] }) {
  const rows = entries.filter((e) => e.quadrant === quadrant);
  return (
    <div className="bg-surface p-3">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-3">{QUADRANT_AXES[quadrant]}</span>
      <div className="mt-2 flex flex-col gap-2.5">
        {rows.map((e) => (
          <div key={e.storeId}>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[12px] font-semibold">{e.name}</span>
              <Pill tone={e.tone}>{e.headline}</Pill>
            </div>
            <table className="mt-1 font-mono text-[11px] text-ink-3">
              <tbody>
                <tr>
                  <td className="pr-2">footfall</td>
                  <td className="pr-1 text-right tabular-nums">{e.footfallPrev}</td>
                  <td className="pr-1">→</td>
                  <td className="pr-2 text-right tabular-nums text-ink-2">{e.footfallNow}</td>
                  <td className={e.footfallChangePct >= 0 ? "text-good" : "text-crit"}>
                    {e.footfallChangePct >= 0 ? "+" : ""}
                    {e.footfallChangePct.toFixed(1)}%
                  </td>
                </tr>
                <tr>
                  <td className="pr-2">conversion</td>
                  <td className="pr-1 text-right tabular-nums">{e.conversionPrev.toFixed(1)}%</td>
                  <td className="pr-1">→</td>
                  <td className="pr-2 text-right tabular-nums text-ink-2">{e.conversionNow.toFixed(1)}%</td>
                  <td className={e.conversionChangePts >= 0 ? "text-good" : "text-crit"}>
                    {e.conversionChangePts >= 0 ? "+" : ""}
                    {e.conversionChangePts.toFixed(1)}pp
                  </td>
                </tr>
                <tr>
                  <td className="pr-2">sales</td>
                  <td className="pr-1 text-right tabular-nums">{INR_SHORT(e.salesPrev)}</td>
                  <td className="pr-1">→</td>
                  <td className="pr-2 text-right tabular-nums text-ink-2">{INR_SHORT(e.salesNow)}</td>
                  <td className={e.salesChangePct !== null && e.salesChangePct >= 0 ? "text-good" : "text-crit"}>
                    {e.salesChangePct !== null ? `${e.salesChangePct >= 0 ? "+" : ""}${e.salesChangePct.toFixed(1)}%` : "—"}
                  </td>
                </tr>
              </tbody>
            </table>
            <div className="mt-0.5 text-[11px] text-ink-2">→ {e.recommendation}</div>
          </div>
        ))}
        {rows.length === 0 && <span className="text-[12px] text-ink-3">—</span>}
      </div>
    </div>
  );
}

export function TrafficSalesCell({ quadrant, entries }: { quadrant: TrafficSalesQuadrant; entries: MatrixEntry[] }) {
  const meta = TRAFFIC_SALES_META[quadrant];
  const rows = entries.filter((e) => trafficSalesQuadrant(e.footfallChangePct, e.salesChangePct) === quadrant);
  return (
    <div className="bg-surface p-3">
      <Pill tone={meta.tone}>{meta.label}</Pill>
      <p className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-ink-3">{meta.axes}</p>
      <p className="mt-1 text-[11px] leading-snug text-ink-3">{meta.meaning}</p>
      <div className="mt-2 flex flex-col gap-1.5">
        {rows.map((e) => (
          <div key={e.storeId} className="text-[12px]">
            <span className="font-semibold">{e.name}</span>
            <div className="font-mono text-[11px] text-ink-3">
              footfall {e.footfallPrev} → {e.footfallNow}{" "}
              <span className={e.footfallChangePct >= 0 ? "text-good" : "text-crit"}>
                ({e.footfallChangePct >= 0 ? "+" : ""}
                {e.footfallChangePct.toFixed(1)}%)
              </span>
            </div>
            <div className="font-mono text-[11px] text-ink-3">
              sales {INR_SHORT(e.salesPrev)} → {INR_SHORT(e.salesNow)}{" "}
              <span className={(e.salesChangePct ?? 0) >= 0 ? "text-good" : "text-crit"}>
                ({(e.salesChangePct ?? 0) >= 0 ? "+" : ""}
                {(e.salesChangePct ?? 0).toFixed(1)}%)
              </span>
            </div>
          </div>
        ))}
        {rows.length === 0 && <span className="text-[12px] text-ink-3">—</span>}
      </div>
    </div>
  );
}
