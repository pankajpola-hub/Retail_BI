/**
 * Store-level WoW sales-decline exceptions — extracted from
 * app/(ho)/network/page.tsx's OverviewRollupSection (Phase 1 of the BI
 * UI/UX architecture work) so the threshold-alerts email digest can reuse
 * the EXACT same exception definition the "Needs attention" panel on
 * /network shows, rather than a second hand-synced copy. Same extraction
 * rationale as lib/sales/aggregate.ts and lib/network/footfall.ts.
 *
 * Do not change the threshold/sort behavior here without also updating
 * both callers' expectations (the page's panel and the alerts digest).
 */
import { buildWeekSeries } from "@/lib/sales/aggregate";
import type { WeeklyRow } from "@/lib/sales/aggregate";

export type StoreException = { storeId: string; name: string; netChangePct: number; net: number };

export function computeStoreExceptions(
  weekRows: WeeklyRow[],
  storesInView: string[],
  storeNames: Map<string, string>,
  thresholdPct = -10
): StoreException[] {
  return storesInView
    .map((sid) => {
      const series = buildWeekSeries(weekRows, sid);
      const latest = series[series.length - 1];
      return latest?.netChangePct != null
        ? { storeId: sid, name: storeNames.get(sid) ?? sid, netChangePct: latest.netChangePct, net: latest.net }
        : null;
    })
    .filter((r): r is StoreException => r !== null && r.netChangePct < thresholdPct)
    .sort((a, b) => a.netChangePct - b.netChangePct);
}
