"use client";

import { useState } from "react";
import { getStoreDrilldownTrend } from "@/lib/workspace/drilldown";
import { TrendChart } from "@/components/ui/TrendChart";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type WeekRow = {
  retailWeek: number;
  weekStart: string;
  net: number;
  netChangePct: number | null;
};

type Point = { label: string; value: number };
type DrilldownState =
  | { status: "loading"; label: string }
  | { status: "loaded"; label: string; points: Point[] }
  | { status: "error"; label: string; message: string };

const INR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * 2026-08-20 — extends the Phase 8 drilldown pattern (StoreLeagueDrilldown.tsx,
 * 2026-08-15) to a second Sales component. Same lazy-fetch contract: a
 * week's daily breakdown is fetched ONLY on click, via the same
 * getStoreDrilldownTrend server action already built for the League table —
 * just scoped to that ONE retail week's 7-day range instead of the whole
 * period, so no new server action was needed.
 *
 * Only per-store tables are clickable (storeId is a real single store). The
 * "Network total" table WeeklySalesTable renders when 2+ stores are in view
 * has no single store to drill into (it's a sum across stores) and stays a
 * plain, inert table — same honesty rule the Mix component follows for
 * multi-store scope.
 */
export function WeeklyRowDrilldown({ storeId, storeName, rows }: { storeId: string; storeName: string; rows: WeekRow[] }) {
  const [drilldown, setDrilldown] = useState<DrilldownState | null>(null);
  const [open, setOpen] = useState(false);

  const weekLabel = (n: number) => `RW${String(n).padStart(2, "0")}`;

  async function openWeek(row: WeekRow) {
    const label = `${storeName} — ${weekLabel(row.retailWeek)} daily breakdown`;
    setOpen(true);
    setDrilldown({ status: "loading", label });
    try {
      const points = await getStoreDrilldownTrend(storeId, row.weekStart, addDays(row.weekStart, 6));
      setDrilldown({ status: "loaded", label, points });
    } catch (err) {
      setDrilldown({ status: "error", label, message: err instanceof Error ? err.message : "Failed to load week detail." });
    }
  }

  return (
    <>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line-soft text-left text-[10px] uppercase tracking-wide text-ink-3">
            <th className="px-3 py-2">Week</th>
            <th className="px-3 py-2 text-right">Net sales</th>
            <th className="px-3 py-2 text-right">WOW</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.weekStart}
              className="cursor-pointer border-b border-line-soft last:border-0 hover:bg-surface-2"
              onClick={() => openWeek(row)}
            >
              <td className="px-3 py-1.5 font-semibold">{weekLabel(row.retailWeek)}</td>
              <td className="px-3 py-1.5 text-right font-mono">{INR(row.net)}</td>
              <td className={`px-3 py-1.5 text-right font-mono ${row.netChangePct === null ? "text-ink-3" : row.netChangePct >= 0 ? "text-good" : "text-crit"}`}>
                {row.netChangePct !== null ? `${row.netChangePct >= 0 ? "+" : ""}${row.netChangePct.toFixed(1)}%` : "—"}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={3} className="px-3 py-4 text-center text-sm text-ink-3">No weeks in range.</td>
            </tr>
          )}
        </tbody>
      </table>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{drilldown?.label ?? ""}</DialogTitle>
          </DialogHeader>
          <div className="mt-3 min-h-[100px]">
            {drilldown?.status === "loading" && <p className="text-sm text-ink-3">Loading…</p>}
            {drilldown?.status === "error" && (
              <p className="border-l-2 border-crit bg-crit-soft px-3 py-2 text-sm text-ink-2">{drilldown.message}</p>
            )}
            {drilldown?.status === "loaded" && drilldown.points.length > 0 && (
              <TrendChart points={drilldown.points} ariaLabel={drilldown.label} />
            )}
            {drilldown?.status === "loaded" && drilldown.points.length === 0 && (
              <p className="py-6 text-center text-sm text-ink-3">No sales data for this week.</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
