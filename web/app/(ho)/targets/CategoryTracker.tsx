import { RemarkCell } from "./remark-cell";

/**
 * Extracted from app/(ho)/targets/page.tsx (2026-08-20) so the Workspace's
 * `fresh_discounted_tracker` component renders the identical table/heat-map
 * this page does, not a resynced copy. `remarks`/`storeId`/`canWriteRemarks`
 * stay optional exactly as before extraction — the Workspace tile renders
 * this WITHOUT them (read-only, no Remarks column, no write affordance),
 * which was already a supported mode of this component, not a new one
 * built for the occasion.
 */
export type TrackerRow = {
  date: string;
  day_name: string;
  day_of_month: number;
  fresh_target_qty: number;
  discounted_target_qty: number;
  fresh_actual_qty: number;
  discounted_actual_qty: number;
  fresh_cum_qty: number;
  discounted_cum_qty: number;
  fresh_mtd_target: number;
  discounted_mtd_target: number;
};

export function pct(actual: number, target: number): string {
  if (target <= 0) return "—";
  return `${Math.round((actual / target) * 100)}%`;
}

// Green -> yellow -> red heat map, same idea as the sheet's own conditional
// formatting: how far ahead/behind pace the MTD Deficit% is, at a glance,
// without reading the number. Clamped at +/-40% — beyond that the color
// stops changing, but the number underneath still shows the real value.
export function deficitHeat(deficitPct: number): string {
  const clamped = Math.max(-40, Math.min(40, deficitPct));
  const t = (clamped + 40) / 80; // 0 = worst behind, 1 = best ahead
  const hue = t * 120; // 0 = red, 120 = green
  return `hsla(${hue}, 70%, 45%, 0.28)`;
}

export function CategoryTracker({
  title,
  bucket,
  monthlyTarget,
  rows,
  targetKey,
  actualKey,
  cumKey,
  mtdTargetKey,
  remarks,
  storeId,
  canWriteRemarks,
}: {
  title: string;
  bucket: "fresh" | "discounted";
  monthlyTarget: number;
  rows: TrackerRow[];
  targetKey: "fresh_target_qty" | "discounted_target_qty";
  actualKey: "fresh_actual_qty" | "discounted_actual_qty";
  cumKey: "fresh_cum_qty" | "discounted_cum_qty";
  mtdTargetKey: "fresh_mtd_target" | "discounted_mtd_target";
  // Remarks column, at the end of each table — Fresh and Discounted each get
  // their own independently-editable remark per day (0038: separate remarks
  // per bucket). Omitting `remarks` renders no Remarks column at all — the
  // Workspace's read-only tile uses this mode.
  remarks?: Record<string, string>;
  storeId?: string;
  canWriteRemarks?: boolean;
}) {
  const latest = rows.at(-1);
  const cumSoFar = latest?.[cumKey] ?? 0;

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">{title}</span>
        <span className="text-[12px] text-ink-3">
          Target {monthlyTarget} · MTD {cumSoFar} ({pct(cumSoFar, monthlyTarget)})
        </span>
      </div>
      <div className="mt-2 overflow-x-auto border border-line-soft">
        <table className="w-full min-w-[560px] text-[12.5px]">
          <thead>
            <tr className="border-b border-line-soft bg-surface-2 text-left text-[10px] uppercase tracking-wide text-ink-3">
              <th className="px-2 py-2">Date</th>
              <th className="px-2 py-2 text-right">MTD target</th>
              <th className="px-2 py-2 text-right">Actual</th>
              <th className="px-2 py-2 text-right">Cumulative</th>
              <th className="px-2 py-2 text-right">Ach%</th>
              <th className="px-2 py-2 text-right">MTD deficit</th>
              {remarks && <th className="px-2 py-2 text-left">Remarks</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const mtdTarget = r[mtdTargetKey];
              const cum = r[cumKey];
              const target = r[targetKey];
              const deficitPct = target > 0 ? ((cum - mtdTarget) / target) * 100 : 0;
              return (
                <tr key={r.date} className="border-b border-line-soft font-mono tabular-nums last:border-0">
                  <td className="px-2 py-1.5 font-sans">
                    {r.day_of_month} {r.day_name}
                  </td>
                  <td className="px-2 py-1.5 text-right text-ink-3">{mtdTarget}</td>
                  <td className="px-2 py-1.5 text-right">{r[actualKey]}</td>
                  <td className="px-2 py-1.5 text-right">{cum}</td>
                  <td className={`px-2 py-1.5 text-right ${cum >= mtdTarget ? "text-good" : "text-crit"}`}>
                    {pct(cum, target)}
                  </td>
                  <td className="px-2 py-1.5 text-right" style={{ backgroundColor: deficitHeat(deficitPct) }}>
                    {deficitPct >= 0 ? "+" : ""}
                    {deficitPct.toFixed(2)}%
                  </td>
                  {remarks && storeId && (
                    <td className="px-2 py-1.5 font-sans">
                      <RemarkCell
                        storeId={storeId}
                        date={r.date}
                        bucket={bucket}
                        initialText={remarks[r.date] ?? ""}
                        editable={Boolean(canWriteRemarks)}
                      />
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
