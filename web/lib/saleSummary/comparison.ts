/**
 * MoM / YoY comparison for /sale-summary (redesign, 2026-08-31) — replaces
 * the original naive "diff the last two months present in scope, no
 * like-to-like check" momPct that used to live in aggregate.ts's
 * computeChannelSalesKpis.
 *
 * JUDGMENT CALL — what "current" and "comparison" mean here: the page's
 * month-range picker sets the ANALYSIS WINDOW every other KPI/table sums
 * over (e.g. "Net sales" = sum of net_amount across the whole selected
 * range). Comparison, by contrast, is always the LATEST bill_month present
 * in the current filtered scope against either the adjacent prior month
 * (MoM) or the same month one year earlier (YoY) — NOT the whole selected
 * range shifted back. Reasoning: a CEO looking at "Last 12 months" wants to
 * know how the range's cumulative total looks, AND how the most recent
 * month is trending against its own baseline — those are two different
 * questions, and the original momPct already answered the second one (just
 * without YoY or a like-to-like option). Shifting the entire multi-month
 * range back instead would answer a third, different question ("is this
 * whole window up vs the equivalent window a year ago") that nobody asked
 * for and that requires the picker's chosen width to also apply to the
 * comparison side, which gets confusing fast once the range is wide. Latest-
 * month-vs-baseline is simpler, matches prior behavior, and is what feeds
 * both the KPI card and every row's growth% in the hierarchy table.
 *
 * Because the comparison month can fall OUTSIDE the page's own fetched
 * month range (e.g. YoY on a "Last 3 months" selection needs data from 12
 * months back), SaleSummaryClient is handed a second, separate row set
 * (`priorRows`, fetched by page.tsx from up to 12 months before the
 * selected range's start) purely to supply that lookback — see page.tsx's
 * own comment on the bound it fetches.
 */

import { num, type ChannelSalesRow } from "./aggregate";
import { shiftMonth } from "./month";

export type ComparisonType = "mom" | "yoy";

function shiftBillMonth(billMonth: string, deltaMonths: number): string {
  return `${shiftMonth(billMonth.slice(0, 7), deltaMonths)}-01`;
}

/** "2026-08-01" + "yoy" -> "2025-08-01". "2026-08-01" + "mom" -> "2026-07-01". */
export function comparisonMonthFor(latestMonth: string, type: ComparisonType): string {
  return shiftBillMonth(latestMonth, type === "mom" ? -1 : -12);
}

/** Latest (lexicographically greatest, safe for 'YYYY-MM-DD') bill_month present in `rows`, or null if empty. */
export function latestMonthIn(rows: ChannelSalesRow[]): string | null {
  let latest: string | null = null;
  for (const r of rows) if (latest === null || r.bill_month > latest) latest = r.bill_month;
  return latest;
}

export type NetworkComparison = {
  latestMonth: string | null;
  comparisonMonth: string | null;
  comparisonType: ComparisonType;
  currentNet: number;
  /** null when the comparison month has no data in scope at all (not even a zero baseline). */
  comparisonNet: number | null;
  growthPct: number | null;
  likeToLike: boolean;
  /** Channels present in the current month only — excluded from both sums when likeToLike is on. */
  excludedNewChannels: number;
  /** Channels present in the comparison month only — excluded from both sums when likeToLike is on. */
  excludedChurnedChannels: number;
  isPartialMonth: boolean;
};

/**
 * `currentMonthRows`/`comparisonMonthRows` must already be facet-filtered
 * and already narrowed to exactly one bill_month each — SaleSummaryClient
 * does both before calling this. This function only sums, and — when
 * `likeToLike` — intersects by channel_name first.
 */
export function computeNetworkComparison(params: {
  currentMonthRows: ChannelSalesRow[];
  comparisonMonthRows: ChannelSalesRow[];
  latestMonth: string | null;
  comparisonMonth: string | null;
  comparisonType: ComparisonType;
  likeToLike: boolean;
  isPartialMonth: boolean;
}): NetworkComparison {
  const { currentMonthRows, comparisonMonthRows, latestMonth, comparisonMonth, comparisonType, likeToLike, isPartialMonth } = params;

  let currentRows = currentMonthRows;
  let comparisonRows = comparisonMonthRows;
  let excludedNewChannels = 0;
  let excludedChurnedChannels = 0;

  if (likeToLike && comparisonMonthRows.length > 0) {
    const currentChannels = new Set(currentMonthRows.map((r) => r.channel_name));
    const comparisonChannels = new Set(comparisonMonthRows.map((r) => r.channel_name));
    excludedNewChannels = [...currentChannels].filter((c) => !comparisonChannels.has(c)).length;
    excludedChurnedChannels = [...comparisonChannels].filter((c) => !currentChannels.has(c)).length;
    currentRows = currentMonthRows.filter((r) => comparisonChannels.has(r.channel_name));
    comparisonRows = comparisonMonthRows.filter((r) => currentChannels.has(r.channel_name));
  }

  const currentNet = currentRows.reduce((s, r) => s + num(r.net_amount), 0);
  const comparisonNet = comparisonMonthRows.length > 0 ? comparisonRows.reduce((s, r) => s + num(r.net_amount), 0) : null;
  const growthPct = comparisonNet !== null && comparisonNet !== 0 ? ((currentNet - comparisonNet) / Math.abs(comparisonNet)) * 100 : null;

  return {
    latestMonth,
    comparisonMonth,
    comparisonType,
    currentNet,
    comparisonNet,
    growthPct,
    likeToLike,
    excludedNewChannels,
    excludedChurnedChannels,
    isPartialMonth,
  };
}

/** Latest-month-vs-comparison-month growth% for one arbitrary row subset (e.g. one Channel Type) — used by the insight strip. null with no comparison data for that subset. */
export function computeGroupGrowth(currentMonthRows: ChannelSalesRow[], comparisonMonthRows: ChannelSalesRow[]): number | null {
  if (comparisonMonthRows.length === 0) return null;
  const currentNet = currentMonthRows.reduce((s, r) => s + num(r.net_amount), 0);
  const comparisonNet = comparisonMonthRows.reduce((s, r) => s + num(r.net_amount), 0);
  if (comparisonNet === 0) return null;
  return ((currentNet - comparisonNet) / Math.abs(comparisonNet)) * 100;
}
