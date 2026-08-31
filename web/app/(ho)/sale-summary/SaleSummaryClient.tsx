"use client";

import { useMemo } from "react";
import { FacetFilterBar, applyFacetFilter, type FacetDef, type AdvField } from "@/components/ui/FacetFilterBar";
import { KpiCard } from "@/components/ui/KpiCard";
import { DeltaBadge } from "@/components/ui/DeltaBadge";
import { TrendChart } from "@/components/ui/TrendChart";
import {
  computeChannelSalesKpis,
  computeBreakdown,
  computeMonthlyTrend,
  num,
  type ChannelSalesRow,
  type BreakdownRow,
} from "@/lib/saleSummary/aggregate";
import { aggregateLeaves, buildHierarchyRows } from "@/lib/saleSummary/hierarchy";
import { computeGroupGrowth, computeNetworkComparison, formatExcludedNames } from "@/lib/saleSummary/comparison";
import { fmtInrAbbrev, fmtCount } from "@/lib/saleSummary/format";
import { HierarchyTable } from "./HierarchyTable";
import { MixDonutChart } from "./MixDonutChart";
import { Sparkline } from "./Sparkline";
import { useSaleSummaryState } from "./SaleSummaryShell";

const PAGE_KEY = "sale_summary";

/** "2026-01" / "2026-01" -> "2026-01"; "2026-01" / "2026-03" -> "2026-01 – 2026-03". Shared by every "Comparing X to Y" caption on this page. */
const rangeLabel = (from: string, to: string) => (from === to ? from : `${from} – ${to}`);

/**
 * Breakdown table with a subtotal/total footer — same "sum extensive
 * columns" convention as PeriodSalesFacetedTable / AgentSalesFacetedTable /
 * StoreDiagnosisFacetedTable. Still used for the Branch/warehouse breakdown
 * — the Channel Type breakdown this table used to also render is gone,
 * replaced by HierarchyTable below. No Discount/Markup % column — removed
 * 2026-08-31, see aggregate.ts's header.
 */
function BreakdownTable({
  rows,
  keyLabel,
  footerLabel,
  emptyLabel,
}: {
  rows: BreakdownRow[];
  keyLabel: string;
  footerLabel: string;
  emptyLabel: string;
}) {
  const totals = useMemo(() => {
    let qty = 0;
    let gross = 0;
    let net = 0;
    for (const r of rows) {
      qty += r.qty;
      gross += r.gross;
      net += r.net;
    }
    return { qty, gross, net };
  }, [rows]);

  return (
    <div className="overflow-x-auto border border-line-soft">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line-soft bg-surface-2 text-left text-[10px] uppercase tracking-wide text-ink-3">
            <th className="px-3 py-2">{keyLabel}</th>
            <th className="px-3 py-2 text-right">Qty</th>
            <th className="px-3 py-2 text-right">Gross (taxable)</th>
            <th className="px-3 py-2 text-right">Net</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-b border-line-soft last:border-0">
              <td className="px-3 py-2">{r.key}</td>
              <td className="px-3 py-2 text-right font-mono">{fmtCount(r.qty)}</td>
              <td className="px-3 py-2 text-right font-mono">{fmtInrAbbrev(r.gross)}</td>
              <td className="px-3 py-2 text-right font-mono">{fmtInrAbbrev(r.net)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="px-3 py-4 text-center text-sm text-ink-3">
                {emptyLabel}
              </td>
            </tr>
          )}
        </tbody>
        {rows.length > 0 && (
          <tfoot>
            <tr className="border-t-2 border-line bg-surface-2 font-bold">
              <td className="px-3 py-2">{footerLabel}</td>
              <td className="px-3 py-2 text-right font-mono">{fmtCount(totals.qty)}</td>
              <td className="px-3 py-2 text-right font-mono">{fmtInrAbbrev(totals.gross)}</td>
              <td className="px-3 py-2 text-right font-mono">{fmtInrAbbrev(totals.net)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

export function SaleSummaryClient({
  rows,
  compareRows,
  fromMonth,
  toMonth,
  compareFromMonth,
  compareToMonth,
}: {
  rows: ChannelSalesRow[];
  /** Empty when comparison is off — page.tsx only fetches this row set when compareFromMonth/compareToMonth are both present. */
  compareRows: ChannelSalesRow[];
  fromMonth: string;
  toMonth: string;
  compareFromMonth: string | null;
  compareToMonth: string | null;
}) {
  // Facet/search state, Returns-only and likeToLike live in SaleSummaryShell's
  // Context, not local useState here — this component remounts on every
  // date-range change (see SaleSummaryShell.tsx for the full root-cause
  // writeup), so anything stored in local state here would silently reset on
  // every such navigation. Reading them via context instead means they're
  // simply re-read from a stable ancestor that never remounts, so they
  // survive. compareFromMonth/compareToMonth, by contrast, arrive as PROPS
  // (sourced from the URL via page.tsx) rather than Context — they're what
  // DRIVES this component's remount/refetch in the first place, so they're
  // naturally always fresh and need no separate persistence.
  const { filterState: state, setFilterState: setState, returnsOnly, setReturnsOnly, likeToLike } = useSaleSummaryState();

  const comparing = Boolean(compareFromMonth && compareToMonth);

  const facets = useMemo<FacetDef<ChannelSalesRow>[]>(
    () => [
      { key: "branch", label: "Branch", get: (r) => r.branch_name },
      { key: "channelType", label: "Channel Type", get: (r) => r.channel_type },
      { key: "channelModel", label: "Channel Model", get: (r) => r.channel_model },
    ],
    []
  );

  // These double as the quick-search fields (FacetFilterBar searches every
  // AdvField on each keystroke) — party_name and channel_name being in here
  // is what satisfies "Channel/Party search" without a second search box:
  // typing "Shoppers Stop" in the page's one search field narrows every KPI,
  // table and the trend chart at once, including the hierarchy table below
  // (which also auto-expands every Channel Type while a search is active —
  // see HierarchyTable's forceExpandAll prop — so a search hit is never
  // hidden behind a collapsed row).
  const advFields = useMemo<AdvField<ChannelSalesRow>[]>(
    () => [
      { key: "party", label: "Party", get: (r) => r.party_name },
      { key: "channel", label: "Channel", get: (r) => r.channel_name },
      { key: "branch", label: "Branch", get: (r) => r.branch_name },
      { key: "channelType", label: "Channel Type", get: (r) => r.channel_type },
      { key: "channelModel", label: "Channel Model", get: (r) => r.channel_model },
      { key: "qty", label: "Qty", get: (r) => Number(r.total_quantity), numeric: true },
      { key: "gross", label: "Gross", get: (r) => Number(r.gross_amount), numeric: true },
      { key: "net", label: "Net", get: (r) => Number(r.net_amount), numeric: true },
    ],
    []
  );

  const groupByOptions = useMemo(
    () => [
      { key: "branch", label: "Branch" },
      { key: "channelType", label: "Channel Type" },
      { key: "channelModel", label: "Channel Model" },
    ],
    []
  );

  const facetFiltered = useMemo(() => applyFacetFilter(rows, facets, advFields, state), [rows, facets, advFields, state]);
  const filtered = useMemo(
    () => (returnsOnly ? facetFiltered.filter((r) => Number(r.total_quantity) < 0) : facetFiltered),
    [facetFiltered, returnsOnly]
  );

  // Same facet/search/returns-only state applied to the comparison range
  // (page.tsx's `compareRows`) — "compare within the same filtered scope for
  // both periods" from the original redesign brief, still true now that the
  // comparison side is an arbitrary range rather than one lookback month.
  // Never fed into FacetFilterBar's own `rows` prop: facet option-counts
  // must stay anchored to what's actually displayed (the main range), not
  // silently widen to include the comparison range the user picked.
  const filteredCompare = useMemo(() => {
    const facetCompare = applyFacetFilter(compareRows, facets, advFields, state);
    return returnsOnly ? facetCompare.filter((r) => Number(r.total_quantity) < 0) : facetCompare;
  }, [compareRows, facets, advFields, state, returnsOnly]);

  const kpis = useMemo(() => computeChannelSalesKpis(filtered), [filtered]);
  const channelTypeRows = useMemo(() => computeBreakdown(filtered, (r) => r.channel_type ?? "(no channel type)"), [filtered]);
  const channelModelRows = useMemo(() => computeBreakdown(filtered, (r) => r.channel_model ?? "(no channel model)"), [filtered]);
  const branchRows = useMemo(() => computeBreakdown(filtered, (r) => r.branch_name), [filtered]);
  const trendPoints = useMemo(() => computeMonthlyTrend(filtered), [filtered]);

  // Per-month net/gross/qty series for the KPI card sparklines — the same
  // grain computeMonthlyTrend already produces for net, extended here to
  // gross/qty too since the sparklines sit on three different cards.
  const monthlySeries = useMemo(() => {
    const byMonth = new Map<string, { net: number; gross: number; qty: number }>();
    for (const r of filtered) {
      const cur = byMonth.get(r.bill_month) ?? { net: 0, gross: 0, qty: 0 };
      cur.net += num(r.net_amount);
      cur.gross += num(r.gross_amount);
      cur.qty += num(r.total_quantity);
      byMonth.set(r.bill_month, cur);
    }
    return [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);
  const netSpark = useMemo(() => monthlySeries.map(([, v]) => v.net), [monthlySeries]);
  const grossSpark = useMemo(() => monthlySeries.map(([, v]) => v.gross), [monthlySeries]);
  const qtySpark = useMemo(() => monthlySeries.map(([, v]) => v.qty), [monthlySeries]);

  // --- Range-vs-range comparison (see lib/saleSummary/comparison.ts for the
  // full "sum the whole main range vs sum the whole comparison range"
  // reasoning) — OFF by default, active only once the user picks a
  // comparison range via ComparisonMonthRangePicker in the sticky header. ---
  const networkComparison = useMemo(
    () =>
      computeNetworkComparison({
        mainFromMonth: fromMonth,
        mainToMonth: toMonth,
        currentRows: filtered,
        comparisonFromMonth: compareFromMonth,
        comparisonToMonth: compareToMonth,
        comparisonRows: filteredCompare,
        likeToLike,
      }),
    [fromMonth, toMonth, filtered, compareFromMonth, compareToMonth, filteredCompare, likeToLike]
  );

  const hierarchyRows = useMemo(() => {
    const scopeLeaves = aggregateLeaves(filtered);
    const growthLeaves = comparing
      ? {
          currentMonthLeaves: aggregateLeaves(filtered),
          comparisonMonthLeaves: filteredCompare.length > 0 ? aggregateLeaves(filteredCompare) : null,
        }
      : null;
    return buildHierarchyRows(scopeLeaves, growthLeaves);
  }, [filtered, comparing, filteredCompare]);

  // --- Auto-generated insight strip — the single largest Channel Type by
  // net sales in the current filtered scope, plus its own growth vs the
  // comparison range when one is active. Template + real numbers, not a
  // canned sentence: every value it prints comes straight out of
  // channelTypeRows/kpis/networkComparison above. ---
  const insight = useMemo(() => {
    const top = channelTypeRows[0];
    if (!top || kpis.totalNet === 0) return null;
    const sharePct = (top.net / kpis.totalNet) * 100;
    const topTypeGrowth =
      comparing && filteredCompare.length > 0
        ? computeGroupGrowth(
            filtered.filter((r) => (r.channel_type ?? "(no channel type)") === top.key),
            filteredCompare.filter((r) => (r.channel_type ?? "(no channel type)") === top.key)
          )
        : null;
    // Both aspects, per Pankaj — "growth to be measure for both aspect qty
    // and value" (value = gross/taxable, not net; see comparison.ts header).
    const growthClause =
      !topTypeGrowth || (topTypeGrowth.qtyGrowthPct === null && topTypeGrowth.grossGrowthPct === null)
        ? ""
        : ` — ${
            topTypeGrowth.grossGrowthPct === null
              ? ""
              : `value ${topTypeGrowth.grossGrowthPct >= 0 ? "up" : "down"} ${Math.abs(topTypeGrowth.grossGrowthPct).toFixed(1)}%`
          }${topTypeGrowth.grossGrowthPct !== null && topTypeGrowth.qtyGrowthPct !== null ? ", " : ""}${
            topTypeGrowth.qtyGrowthPct === null
              ? ""
              : `qty ${topTypeGrowth.qtyGrowthPct >= 0 ? "up" : "down"} ${Math.abs(topTypeGrowth.qtyGrowthPct).toFixed(1)}%`
          } vs ${rangeLabel(compareFromMonth as string, compareToMonth as string)}`;
    return `${top.key} drove ${sharePct.toFixed(0)}% of net sales in this scope (${fmtInrAbbrev(top.net)})${growthClause}.`;
  }, [channelTypeRows, kpis.totalNet, comparing, filteredCompare, filtered, compareFromMonth, compareToMonth]);

  // Shared "Comparing Jan 2026 – Mar 2026 to Oct 2025 – Dec 2025." caption —
  // every table/card that shows a growth figure repeats this exact line so
  // the comparison window is never implicit (per Pankaj: "this kind of
  // details to be shown on every table top wherever there is comparison like
  // growth"). States the actual ranges, not a computed single month.
  const comparisonPeriodLabel = comparing
    ? `Comparing ${rangeLabel(fromMonth, toMonth)} to ${rangeLabel(compareFromMonth as string, compareToMonth as string)}${
        networkComparison.comparisonGross === null ? " — no data for the comparison range in this scope" : ""
      }.`
    : "Comparison is off — use the “+ Compare” control in the header above to compare this range against another.";

  const hasSearchActive = state.search.trim().length > 0;

  return (
    <>
      {insight && (
        <div className="mb-4 rounded-md border border-line-soft bg-surface-2 px-3.5 py-2.5 text-[13px] text-ink-2">{insight}</div>
      )}

      {
        // Discount/Markup % KPI card removed 2026-08-31 — see aggregate.ts's
        // header: gross is taxable value, net is after-tax, so (gross-net)/
        // gross was a tax-rate artifact, not a real discount, and the
        // correct basis differs party-by-party. Hidden everywhere on this
        // page until a proper discount engine replaces it.
      }
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard label="Net sales" value={fmtInrAbbrev(kpis.totalNet)} sub={<Sparkline values={netSpark} />} />
        <KpiCard label="Gross sales (taxable)" value={fmtInrAbbrev(kpis.totalGross)} sub={<Sparkline values={grossSpark} />} />
        <KpiCard label="Total qty" value={fmtCount(kpis.totalQty)} sub={<Sparkline values={qtySpark} />} />
        <KpiCard
          label="Returns value"
          value={fmtInrAbbrev(kpis.returnsValue)}
          sub="Σ net, negative-quantity rows"
        />
        <KpiCard label="Active channels" value={String(kpis.activeChannels)} />
      </div>

      {
        // Growth panel — only meaningful once comparison is ON (ask 4:
        // "'Comparison settings' should be optional only if user wants to
        // use only"). Its own range picker/like-to-like toggle now live in
        // the sticky header next to the main date filter (ask 3), so this
        // card is read-only: numbers when comparing, a one-line nudge when
        // not.
      }
      <div className="mt-3 rounded-lg border border-line-soft bg-surface px-4 pb-4 pt-4 shadow-sm sm:max-w-xl">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.11em] text-ink-3">Growth — qty &amp; value</div>
          {comparing && networkComparison.isPartialMonth && (
            <span
              className="rounded-full border border-dashed border-line px-2 py-0.5 text-[10.5px] text-ink-3"
              title="The latest month in one of the compared ranges is still accumulating data."
            >
              Partial month
            </span>
          )}
        </div>
        <p className="mt-1 text-[11px] text-ink-3">{comparisonPeriodLabel}</p>
        {comparing && (
          <>
            <div className="mt-3 grid grid-cols-2 gap-4">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-ink-3">Value (taxable)</div>
                <div className="font-mono font-tabular mt-1 text-[22px] leading-none tracking-tight text-ink">
                  {networkComparison.grossGrowthPct === null
                    ? "—"
                    : `${networkComparison.grossGrowthPct >= 0 ? "+" : ""}${networkComparison.grossGrowthPct.toFixed(1)}%`}
                </div>
                <DeltaBadge
                  current={networkComparison.currentGross}
                  previous={networkComparison.comparisonGross}
                  baselineLabel={`${rangeLabel(compareFromMonth as string, compareToMonth as string)} → ${rangeLabel(fromMonth, toMonth)}`}
                />
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-ink-3">Qty</div>
                <div className="font-mono font-tabular mt-1 text-[22px] leading-none tracking-tight text-ink">
                  {networkComparison.qtyGrowthPct === null
                    ? "—"
                    : `${networkComparison.qtyGrowthPct >= 0 ? "+" : ""}${networkComparison.qtyGrowthPct.toFixed(1)}%`}
                </div>
                <DeltaBadge
                  current={networkComparison.currentQty}
                  previous={networkComparison.comparisonQty}
                  baselineLabel={`${rangeLabel(compareFromMonth as string, compareToMonth as string)} → ${rangeLabel(fromMonth, toMonth)}`}
                />
              </div>
            </div>
            {
              // Like-to-like detail (ask 1, per Pankaj: "need more extensive
              // detailed mentioned there") — names the actual excluded
              // channels, not just a count, truncated past
              // EXCLUDED_NAME_DISPLAY_LIMIT via formatExcludedNames so a big
              // onboarding/churn wave doesn't produce a wall of text.
              likeToLike &&
                networkComparison.likeToLike &&
                (networkComparison.excludedNewChannelNames.length > 0 || networkComparison.excludedChurnedChannelNames.length > 0) && (
                  <p className="mt-2 text-[11px] text-ink-3">
                    Like-to-like: excluded {networkComparison.excludedNewChannelNames.length} new
                    {networkComparison.excludedNewChannelNames.length > 0
                      ? ` (${formatExcludedNames(networkComparison.excludedNewChannelNames)})`
                      : ""}{" "}
                    and {networkComparison.excludedChurnedChannelNames.length} discontinued
                    {networkComparison.excludedChurnedChannelNames.length > 0
                      ? ` (${formatExcludedNames(networkComparison.excludedChurnedChannelNames)})`
                      : ""}{" "}
                    channel
                    {networkComparison.excludedNewChannelNames.length + networkComparison.excludedChurnedChannelNames.length === 1
                      ? ""
                      : "s"}{" "}
                    from this delta.
                  </p>
                )
            }
          </>
        )}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <FacetFilterBar
          pageKey={PAGE_KEY}
          rows={rows}
          facets={facets}
          advFields={advFields}
          groupByOptions={groupByOptions}
          state={state}
          onChange={setState}
        />
        <label className="ml-1 flex min-h-[32px] items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-[12.5px] text-ink-2">
          <input type="checkbox" checked={returnsOnly} onChange={(e) => setReturnsOnly(e.target.checked)} />
          Returns only (qty &lt; 0)
        </label>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-3 lg:grid-cols-[1.6fr_1fr]">
        <div>
          <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Channel Model / Type / Name</span>
          <p className="mt-1 text-[11.5px] text-ink-3">
            Collapsed to Channel Model + Channel Type by default — click a Channel Type row to reveal its Channel Name parties. The two
            Growth columns reflect this range vs the comparison range, not a single month. {comparisonPeriodLabel}
          </p>
          <div className="mt-2">
            <HierarchyTable rows={hierarchyRows} forceExpandAll={hasSearchActive} emptyLabel="No rows match these filters." />
          </div>
        </div>
        <MixDonutChart modelRows={channelModelRows} typeRows={channelTypeRows} />
      </div>

      <div className="mt-6">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Branch / warehouse breakdown</span>
        <div className="mt-2">
          <BreakdownTable rows={branchRows} keyLabel="Branch" footerLabel="Total" emptyLabel="No rows match these filters." />
        </div>
      </div>

      <div className="mt-6">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Monthly trend — net sales</span>
        <div className="mt-2 border border-line-soft p-3">
          {trendPoints.length === 0 ? (
            <p className="py-10 text-center text-sm text-ink-3">No data in this month range / filter.</p>
          ) : (
            <TrendChart points={trendPoints} ariaLabel="Net sales by month, wholesale/distribution channels" valueFormatter={fmtInrAbbrev} />
          )}
        </div>
      </div>
    </>
  );
}
