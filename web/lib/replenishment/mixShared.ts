// Deliberately NOT "server-only" — classifyMixGap/MIX_STATUS_META are pure
// functions with no DB access, and lib/replenishment/mixAttributes.ts needs
// to run this same classification client-side (attribute-wise Sale vs Stock
// Mix views are recomputed in the browser when the user switches the "View
// by" pill, same as FacetFilterBar's own filter/group-by state). Splitting
// these out of mix.ts (which IS server-only, for its Supabase queries) is
// what lets both sides import the identical logic instead of a second
// hand-synced copy — SaleStockMixGrid.tsx already had to duplicate
// MIX_STATUS_META for exactly this reason before this file existed.

export type MixStatus = "high_priority" | "opportunity" | "balanced" | "stock_heavy" | "overstocked";

export const MIX_STATUS_META: Record<
  MixStatus,
  { dot: string; label: string; demandLabel: string; action: string; className: string }
> = {
  high_priority: {
    dot: "🔥",
    label: "High Priority",
    demandLabel: "High Demand / Low Stock",
    action: "Prioritize Allocation",
    className: "text-crit font-semibold",
  },
  opportunity: {
    dot: "🟢",
    label: "Allocation Opportunity",
    demandLabel: "Demand Higher Than Stock",
    action: "Consider Allocation",
    className: "text-good font-semibold",
  },
  balanced: {
    dot: "✅",
    label: "Balanced",
    demandLabel: "Balanced",
    action: "Maintain",
    className: "text-ink-2",
  },
  stock_heavy: {
    dot: "🟠",
    label: "Stock Heavy",
    demandLabel: "Stock Higher Than Demand",
    action: "Reduce / Hold Allocation",
    className: "text-warn font-semibold",
  },
  overstocked: {
    dot: "🔴",
    label: "Overstocked",
    demandLabel: "Low Demand / High Stock",
    action: "Do Not Allocate",
    className: "text-crit font-semibold",
  },
};

// Boundaries taken literally from the spec, with the two ties (+5pp,
// -10pp... and -5pp) each resolved toward the MORE extreme bucket, mirroring
// how the spec's own ">=5 and <10" phrasing puts +5 in Opportunity rather
// than Balanced — the symmetric choice puts -5 in Stock Heavy rather than
// Balanced, so a group never lands in two buckets depending on
// floating-point rounding.
export function classifyMixGap(gapPts: number): MixStatus {
  if (gapPts >= 10) return "high_priority";
  if (gapPts >= 5) return "opportunity";
  if (gapPts > -5) return "balanced";
  if (gapPts >= -10) return "stock_heavy";
  return "overstocked";
}
