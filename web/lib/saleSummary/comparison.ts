/**
 * Range-vs-range comparison for /sale-summary (2026-08-31 redesign #2 —
 * replaces the original "latest month in scope vs one adjacent MoM/YoY
 * month" model, itself a 2026-08-31 rewrite of the very first naive "diff
 * the last two months present in scope" momPct).
 *
 * WHY THE MODEL CHANGED AGAIN: the first redesign deliberately compared only
 * the latest single month against one fixed baseline, reasoning that a wide
 * multi-month selection and its comparison were "two different questions."
 * Pankaj's explicit ask ("add same filter as date filter in comparison
 * settings so user can compare any date range with any date range") makes
 * that no longer optional — the user must be able to pick an arbitrary
 * comparison range (e.g. "Jan-Mar 2026" vs "Jan-Mar 2025"), not just a single
 * trailing month. The model here is now genuinely symmetric with the main
 * range: SUM everything in the main (already facet-filtered) row set vs SUM
 * everything in the comparison (same facet filters applied) row set, however
 * wide either range is. This is also the same shape /sales' own
 * compareFrom/compareTo KPI comparison already uses (see that page's
 * computeSalesTotals(rows, from) called twice, once per range) — see
 * app/(ho)/sales/page.tsx.
 *
 * Comparison is OFF by default and only ever active when the caller supplies
 * real comparisonFromMonth/comparisonToMonth strings — see page.tsx
 * (compareFromMonth/compareToMonth URL params) and
 * ComparisonMonthRangePicker.tsx.
 *
 * MEASURED ON QTY AND GROSS, NOT NET (2026-08-31, per Pankaj, unchanged from
 * the prior redesign): growth is tracked for both "how many units" (qty) and
 * "how much taxable value" (gross_amount — the everyday meaning of "value"
 * for this data; net_amount is AFTER-TAX and its own relationship to gross
 * differs party-by-party, see aggregate.ts's header on why discount/markup %
 * was removed for the same reason).
 *
 * Every ratio here is recomputed from summed parts (Σqty, Σgross), never
 * averaged from per-row/per-month percentages — this codebase's hard rule.
 */

import { num, type ChannelSalesRow } from "./aggregate";
import { currentYm } from "./month";

/** Latest (lexicographically greatest, safe for 'YYYY-MM-DD') bill_month present in `rows`, or null if empty. */
export function latestMonthIn(rows: ChannelSalesRow[]): string | null {
  let latest: string | null = null;
  for (const r of rows) if (latest === null || r.bill_month > latest) latest = r.bill_month;
  return latest;
}

/** How many distinct excluded-channel names to name before collapsing to "+N more" in the like-to-like caption — keeps a long onboarding/churn list from becoming an unreadable wall of text. */
const EXCLUDED_NAME_DISPLAY_LIMIT = 6;

export type NetworkComparison = {
  mainFromMonth: string;
  mainToMonth: string;
  comparisonFromMonth: string | null;
  comparisonToMonth: string | null;
  /** True once real comparisonFromMonth/comparisonToMonth are supplied — mirrors "both compareFromMonth and compareToMonth are in the URL" at the page level. */
  active: boolean;
  currentQty: number;
  /** null when comparison is off, or on but the comparison range has no data in scope at all (not even a zero baseline). */
  comparisonQty: number | null;
  qtyGrowthPct: number | null;
  currentGross: number;
  comparisonGross: number | null;
  grossGrowthPct: number | null;
  likeToLike: boolean;
  /** Channels present in the main range only — excluded from both sums when likeToLike is on. Full list; see EXCLUDED_NAME_DISPLAY_LIMIT / formatExcludedNames for how the caption truncates it. */
  excludedNewChannelNames: string[];
  /** Channels present in the comparison range only — excluded from both sums when likeToLike is on. */
  excludedChurnedChannelNames: string[];
  /** True when the latest bill_month in EITHER range is the real current calendar month (i.e. that range's most recent month is still accumulating data), per Pankaj's original partial-month caveat — kept as a display-only flag, doesn't affect the sums above. */
  isPartialMonth: boolean;
};

/** Renders an excluded-channel-names list for the like-to-like caption, truncating past EXCLUDED_NAME_DISPLAY_LIMIT so a large onboarding/churn wave doesn't produce an unreadable sentence. */
export function formatExcludedNames(names: string[]): string {
  if (names.length <= EXCLUDED_NAME_DISPLAY_LIMIT) return names.join(", ");
  const shown = names.slice(0, EXCLUDED_NAME_DISPLAY_LIMIT);
  return `${shown.join(", ")}, +${names.length - EXCLUDED_NAME_DISPLAY_LIMIT} more`;
}

/**
 * `currentRows`/`comparisonRows` must already be facet-filtered (and
 * Returns-only-filtered) by the caller — SaleSummaryClient does both, once
 * per range, before calling this. This function only sums, and — when
 * `likeToLike` — intersects by channel_name first.
 */
export function computeNetworkComparison(params: {
  mainFromMonth: string;
  mainToMonth: string;
  currentRows: ChannelSalesRow[];
  comparisonFromMonth: string | null;
  comparisonToMonth: string | null;
  comparisonRows: ChannelSalesRow[];
  likeToLike: boolean;
}): NetworkComparison {
  const { mainFromMonth, mainToMonth, currentRows, comparisonFromMonth, comparisonToMonth, comparisonRows, likeToLike } = params;
  const active = Boolean(comparisonFromMonth && comparisonToMonth);

  let currentRowsForSum = currentRows;
  let comparisonRowsForSum = comparisonRows;
  let excludedNewChannelNames: string[] = [];
  let excludedChurnedChannelNames: string[] = [];

  if (likeToLike && active && comparisonRows.length > 0) {
    const currentChannels = new Set(currentRows.map((r) => r.channel_name));
    const comparisonChannels = new Set(comparisonRows.map((r) => r.channel_name));
    excludedNewChannelNames = [...currentChannels].filter((c) => !comparisonChannels.has(c)).sort();
    excludedChurnedChannelNames = [...comparisonChannels].filter((c) => !currentChannels.has(c)).sort();
    currentRowsForSum = currentRows.filter((r) => comparisonChannels.has(r.channel_name));
    comparisonRowsForSum = comparisonRows.filter((r) => currentChannels.has(r.channel_name));
  }

  const sumQty = (rs: ChannelSalesRow[]) => rs.reduce((s, r) => s + num(r.total_quantity), 0);
  const sumGross = (rs: ChannelSalesRow[]) => rs.reduce((s, r) => s + num(r.gross_amount), 0);
  const pct = (curr: number, prev: number | null): number | null => (prev === null || prev === 0 ? null : ((curr - prev) / Math.abs(prev)) * 100);

  const currentQty = sumQty(currentRowsForSum);
  const comparisonQty = active && comparisonRows.length > 0 ? sumQty(comparisonRowsForSum) : null;
  const currentGross = sumGross(currentRowsForSum);
  const comparisonGross = active && comparisonRows.length > 0 ? sumGross(comparisonRowsForSum) : null;

  const nowYm = currentYm();
  const mainLatest = latestMonthIn(currentRows);
  const comparisonLatest = latestMonthIn(comparisonRows);
  const isPartialMonth =
    (mainLatest !== null && mainLatest.slice(0, 7) === nowYm) || (comparisonLatest !== null && comparisonLatest.slice(0, 7) === nowYm);

  return {
    mainFromMonth,
    mainToMonth,
    comparisonFromMonth,
    comparisonToMonth,
    active,
    currentQty,
    comparisonQty,
    qtyGrowthPct: pct(currentQty, comparisonQty),
    currentGross,
    comparisonGross,
    grossGrowthPct: pct(currentGross, comparisonGross),
    likeToLike,
    excludedNewChannelNames,
    excludedChurnedChannelNames,
    isPartialMonth,
  };
}

/** {qty, gross} growth% for one arbitrary row subset (e.g. one Channel Type) over the main range vs the same subset over the comparison range — used by the insight strip and (via hierarchy.ts) every hierarchy table row. Each field null independently when there's no comparison data/zero baseline for that metric. Generic over range width — works identically whether `comparisonRows` spans one month or a dozen. */
export function computeGroupGrowth(
  currentRows: ChannelSalesRow[],
  comparisonRows: ChannelSalesRow[]
): { qtyGrowthPct: number | null; grossGrowthPct: number | null } {
  if (comparisonRows.length === 0) return { qtyGrowthPct: null, grossGrowthPct: null };
  const pct = (curr: number, prev: number): number | null => (prev === 0 ? null : ((curr - prev) / Math.abs(prev)) * 100);
  const currentQty = currentRows.reduce((s, r) => s + num(r.total_quantity), 0);
  const comparisonQty = comparisonRows.reduce((s, r) => s + num(r.total_quantity), 0);
  const currentGross = currentRows.reduce((s, r) => s + num(r.gross_amount), 0);
  const comparisonGross = comparisonRows.reduce((s, r) => s + num(r.gross_amount), 0);
  return { qtyGrowthPct: pct(currentQty, comparisonQty), grossGrowthPct: pct(currentGross, comparisonGross) };
}
