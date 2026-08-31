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
import {
  comparisonMonthFor,
  computeGroupGrowth,
  computeNetworkComparison,
  latestMonthIn,
  type ComparisonType,
} from "@/lib/saleSummary/comparison";
import { currentYm } from "@/lib/saleSummary/month";
import { fmtInrAbbrev, fmtCount } from "@/lib/saleSummary/format";
import { HierarchyTable } from "./HierarchyTable";
import { MixDonutChart } from "./MixDonutChart";
import { Sparkline } from "./Sparkline";
import { useSaleSummaryState } from "./SaleSummaryShell";

const PAGE_KEY = "sale_summary";

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

const COMPARISON_LABELS: Record<ComparisonType, string> = { mom: "MoM", yoy: "YoY" };

export function SaleSummaryClient({ rows, priorRows }: { rows: ChannelSalesRow[]; priorRows: ChannelSalesRow[] }) {
  // Facet/search state, Returns-only, comparisonType and likeToLike ALL live
  // in SaleSummaryShell's Context now, not local useState here — this
  // component remounts on every date-range change (see SaleSummaryShell.tsx
  // for the full root-cause writeup), so anything stored in local state here
  // would silently reset on every such navigation. Reading them via context
  // instead means they're simply re-read from a stable ancestor that never
  // remounts, so they survive.
  const { filterState: state, setFilterState: setState, returnsOnly, setReturnsOnly, comparisonType, setComparisonType, likeToLike, setLikeToLike } =
    useSaleSummaryState();

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

  // Same facet/search/returns-only state applied to the lookback row set
  // (page.tsx's `priorRows`, up to 12 months before the displayed range) —
  // "compare within the same filtered scope for both periods" from the
  // redesign brief. Never fed into FacetFilterBar's own `rows` prop: facet
  // option-counts must stay anchored to what's actually displayed, not
  // silently widen to include months the user never selected.
  const filteredPrior = useMemo(() => {
    const facetPrior = applyFacetFilter(priorRows, facets, advFields, state);
    return returnsOnly ? facetPrior.filter((r) => Number(r.total_quantity) < 0) : facetPrior;
  }, [priorRows, facets, advFields, state, returnsOnly]);

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

  // --- MoM/YoY comparison (see lib/saleSummary/comparison.ts for the full
  // "what counts as current/comparison" reasoning) ---
  const latestMonth = useMemo(() => latestMonthIn(filtered), [filtered]);
  const comparisonMonth = useMemo(() => (latestMonth ? comparisonMonthFor(latestMonth, comparisonType) : null), [latestMonth, comparisonType]);
  const currentMonthRows = useMemo(() => (latestMonth ? filtered.filter((r) => r.bill_month === latestMonth) : []), [filtered, latestMonth]);
  const comparisonMonthRows = useMemo(() => {
    if (!comparisonMonth) return [];
    // The comparison month can be inside the displayed range itself (e.g.
    // MoM when two consecutive months are both selected) or only reachable
    // via the lookback set — check both.
    return [...filtered, ...filteredPrior].filter((r) => r.bill_month === comparisonMonth);
  }, [filtered, filteredPrior, comparisonMonth]);
  const isPartialMonth = latestMonth !== null && latestMonth.slice(0, 7) === currentYm();

  const networkComparison = useMemo(
    () =>
      computeNetworkComparison({
        currentMonthRows,
        comparisonMonthRows,
        latestMonth,
        comparisonMonth,
        comparisonType,
        likeToLike,
        isPartialMonth,
      }),
    [currentMonthRows, comparisonMonthRows, latestMonth, comparisonMonth, comparisonType, likeToLike, isPartialMonth]
  );

  const hierarchyRows = useMemo(() => {
    const scopeLeaves = aggregateLeaves(filtered);
    const growthLeaves = latestMonth
      ? {
          currentMonthLeaves: aggregateLeaves(currentMonthRows),
          comparisonMonthLeaves: comparisonMonthRows.length > 0 ? aggregateLeaves(comparisonMonthRows) : null,
        }
      : null;
    return buildHierarchyRows(scopeLeaves, growthLeaves);
  }, [filtered, latestMonth, currentMonthRows, comparisonMonthRows]);

  // --- Auto-generated insight strip — the single largest Channel Type by
  // net sales in the current filtered scope, plus its own MoM/YoY delta
  // when a comparison baseline exists. Template + real numbers, not a
  // canned sentence: every value it prints comes straight out of
  // channelTypeRows/kpis/networkComparison above. ---
  const insight = useMemo(() => {
    const top = channelTypeRows[0];
    if (!top || kpis.totalNet === 0) return null;
    const sharePct = (top.net / kpis.totalNet) * 100;
    const topTypeGrowth =
      latestMonth && comparisonMonthRows.length > 0
        ? computeGroupGrowth(
            currentMonthRows.filter((r) => (r.channel_type ?? "(no channel type)") === top.key),
            comparisonMonthRows.filter((r) => (r.channel_type ?? "(no channel type)") === top.key)
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
          } ${COMPARISON_LABELS[comparisonType]} for ${latestMonth!.slice(0, 7)}`;
    return `${top.key} drove ${sharePct.toFixed(0)}% of net sales in this scope (${fmtInrAbbrev(top.net)})${growthClause}.`;
  }, [channelTypeRows, kpis.totalNet, latestMonth, comparisonMonthRows, currentMonthRows, comparisonType]);

  // Shared "Comparing 2026-08 to 2025-08." caption — every table/card that
  // shows a growth figure repeats this exact line so the comparison window
  // is never implicit (per Pankaj: "this kind of details to be shown on
  // every table top wherever there is comparison like growth").
  const comparisonPeriodLabel = networkComparison.latestMonth
    ? `Comparing ${networkComparison.latestMonth.slice(0, 7)} to ${
        networkComparison.comparisonMonth ? networkComparison.comparisonMonth.slice(0, 7) : "—"
      } (${COMPARISON_LABELS[comparisonType]})${networkComparison.comparisonGross === null ? " — no data for the comparison month in this scope" : ""}.`
    : "No months in the current scope to compare.";

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

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-line-soft bg-surface px-4 pb-4 pt-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.11em] text-ink-3">
              {COMPARISON_LABELS[comparisonType]} growth — qty &amp; value
            </div>
            {isPartialMonth && (
              <span className="rounded-full border border-dashed border-line px-2 py-0.5 text-[10.5px] text-ink-3" title="The latest month in scope is still accumulating data.">
                Partial month
              </span>
            )}
          </div>
          <p className="mt-1 text-[11px] text-ink-3">{comparisonPeriodLabel}</p>
          <div className="mt-3 grid grid-cols-2 gap-4">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-ink-3">Value (taxable)</div>
              <div className="font-mono font-tabular mt-1 text-[22px] leading-none tracking-tight text-ink">
                {networkComparison.grossGrowthPct === null ? "—" : `${networkComparison.grossGrowthPct >= 0 ? "+" : ""}${networkComparison.grossGrowthPct.toFixed(1)}%`}
              </div>
              <DeltaBadge
                current={networkComparison.currentGross}
                previous={networkComparison.comparisonGross}
                baselineLabel={
                  networkComparison.latestMonth && networkComparison.comparisonMonth
                    ? `${networkComparison.comparisonMonth.slice(0, 7)} → ${networkComparison.latestMonth.slice(0, 7)}`
                    : "vs comparison period"
                }
              />
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-ink-3">Qty</div>
              <div className="font-mono font-tabular mt-1 text-[22px] leading-none tracking-tight text-ink">
                {networkComparison.qtyGrowthPct === null ? "—" : `${networkComparison.qtyGrowthPct >= 0 ? "+" : ""}${networkComparison.qtyGrowthPct.toFixed(1)}%`}
              </div>
              <DeltaBadge
                current={networkComparison.currentQty}
                previous={networkComparison.comparisonQty}
                baselineLabel={
                  networkComparison.latestMonth && networkComparison.comparisonMonth
                    ? `${networkComparison.comparisonMonth.slice(0, 7)} → ${networkComparison.latestMonth.slice(0, 7)}`
                    : "vs comparison period"
                }
              />
            </div>
          </div>
          {likeToLike && networkComparison.likeToLike && (networkComparison.excludedNewChannels > 0 || networkComparison.excludedChurnedChannels > 0) && (
            <p className="mt-2 text-[11px] text-ink-3">
              Like-to-like: excluded {networkComparison.excludedNewChannels} new + {networkComparison.excludedChurnedChannels} discontinued channel
              {networkComparison.excludedNewChannels + networkComparison.excludedChurnedChannels === 1 ? "" : "s"} from this delta.
            </p>
          )}
        </div>

        <div className="rounded-lg border border-dashed border-line-soft bg-surface px-4 pb-4 pt-4">
          <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.11em] text-ink-3">Comparison settings</div>
          <div className="flex flex-wrap items-center gap-2">
            {(["mom", "yoy"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setComparisonType(t)}
                className={`rounded-full border px-3 py-1 text-[12.5px] font-medium ${
                  comparisonType === t ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-ink-3 hover:text-ink-2"
                }`}
              >
                {t === "mom" ? "Month-over-month" : "Year-over-year"}
              </button>
            ))}
            <label className="ml-1 flex min-h-[32px] items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-[12.5px] text-ink-2">
              <input type="checkbox" checked={likeToLike} onChange={(e) => setLikeToLike(e.target.checked)} />
              Compare like-to-like only
            </label>
          </div>
          <p className="mt-2 text-[11px] text-ink-3">{comparisonPeriodLabel}</p>
        </div>
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
            Growth columns reflect the latest month in scope, not the full range total above. {comparisonPeriodLabel}
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
