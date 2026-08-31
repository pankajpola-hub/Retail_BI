"use client";

import { useMemo, useState } from "react";
import {
  FacetFilterBar,
  applyFacetFilter,
  emptyFilterState,
  type FacetDef,
  type AdvField,
  type FacetFilterState,
} from "@/components/ui/FacetFilterBar";
import { KpiCard } from "@/components/ui/KpiCard";
import { TrendChart } from "@/components/ui/TrendChart";
import {
  computeChannelSalesKpis,
  computeBreakdown,
  computeMonthlyTrend,
  type ChannelSalesRow,
  type BreakdownRow,
} from "@/lib/saleSummary/aggregate";

const PAGE_KEY = "sale_summary";
const TOP_PARTIES_LIMIT = 50;

const INR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const pctLabel = (n: number | null) => (n === null ? "—" : `${n.toFixed(1)}%`);

/**
 * Breakdown table with a subtotal/total footer — same "never average a
 * ratio column" convention as PeriodSalesFacetedTable / AgentSalesFacetedTable
 * / StoreDiagnosisFacetedTable: qty/gross/net sum, discountPct is
 * RECOMPUTED from the summed gross/net (not an average of the per-row %s).
 * `footerLabel` lets the Top Parties table say "Total — top N parties"
 * instead of a misleading grand "Total" once the list is capped.
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
    return { qty, gross, net, discountPct: gross !== 0 ? ((gross - net) / gross) * 100 : null };
  }, [rows]);

  return (
    <div className="overflow-x-auto border border-line-soft">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line-soft bg-surface-2 text-left text-[10px] uppercase tracking-wide text-ink-3">
            <th className="px-3 py-2">{keyLabel}</th>
            <th className="px-3 py-2 text-right">Qty</th>
            <th className="px-3 py-2 text-right">Gross</th>
            <th className="px-3 py-2 text-right">Net</th>
            <th className="px-3 py-2 text-right">Discount / Markup %</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-b border-line-soft last:border-0">
              <td className="px-3 py-2">{r.key}</td>
              <td className="px-3 py-2 text-right font-mono">{Math.round(r.qty).toLocaleString("en-IN")}</td>
              <td className="px-3 py-2 text-right font-mono">{INR(r.gross)}</td>
              <td className="px-3 py-2 text-right font-mono">{INR(r.net)}</td>
              <td className="px-3 py-2 text-right font-mono">
                {r.discountPct === null ? "—" : r.discountPct < 0 ? `${Math.abs(r.discountPct).toFixed(1)}% markup` : `${r.discountPct.toFixed(1)}%`}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="px-3 py-4 text-center text-sm text-ink-3">
                {emptyLabel}
              </td>
            </tr>
          )}
        </tbody>
        {rows.length > 0 && (
          <tfoot>
            <tr className="border-t-2 border-line bg-surface-2 font-bold">
              <td className="px-3 py-2">{footerLabel}</td>
              <td className="px-3 py-2 text-right font-mono">{Math.round(totals.qty).toLocaleString("en-IN")}</td>
              <td className="px-3 py-2 text-right font-mono">{INR(totals.gross)}</td>
              <td className="px-3 py-2 text-right font-mono">{INR(totals.net)}</td>
              <td className="px-3 py-2 text-right font-mono">
                {totals.discountPct === null
                  ? "—"
                  : totals.discountPct < 0
                    ? `${Math.abs(totals.discountPct).toFixed(1)}% markup`
                    : `${totals.discountPct.toFixed(1)}%`}
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

export function SaleSummaryClient({ rows }: { rows: ChannelSalesRow[] }) {
  const [state, setState] = useState<FacetFilterState>(emptyFilterState);
  // Returns-only is a simple boolean toggle, deliberately kept OUTSIDE
  // FacetFilterState (which models multi-select facets, free-text search,
  // and advanced field conditions — a plain "show only negative-quantity
  // rows" switch doesn't fit any of those shapes cleanly, and forcing it
  // into an AdvField condition would make it removable/editable via the
  // chip row like any other filter, which is confusing for what's meant to
  // read as a single on/off switch).
  const [returnsOnly, setReturnsOnly] = useState(false);

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
  // table and the trend chart at once, including the Top Parties table.
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

  const kpis = useMemo(() => computeChannelSalesKpis(filtered), [filtered]);
  const channelTypeRows = useMemo(() => computeBreakdown(filtered, (r) => r.channel_type ?? "(no channel type)"), [filtered]);
  const branchRows = useMemo(() => computeBreakdown(filtered, (r) => r.branch_name), [filtered]);
  const allPartyRows = useMemo(() => computeBreakdown(filtered, (r) => r.party_name), [filtered]);
  const topPartyRows = useMemo(() => allPartyRows.slice(0, TOP_PARTIES_LIMIT), [allPartyRows]);
  const trendPoints = useMemo(() => computeMonthlyTrend(filtered), [filtered]);

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <KpiCard label="Net sales" value={INR(kpis.totalNet)} />
        <KpiCard label="Gross sales" value={INR(kpis.totalGross)} />
        <KpiCard label="Total qty" value={Math.round(kpis.totalQty).toLocaleString("en-IN")} />
        <KpiCard
          label={kpis.isMarkup ? "Markup %" : "Discount %"}
          value={kpis.discountPct === null ? "—" : `${Math.abs(kpis.discountPct).toFixed(1)}%`}
          sub={
            kpis.isMarkup
              ? "Net exceeds gross for this scope — expected for this channel, see docs."
              : undefined
          }
        />
        <KpiCard
          label="Returns value"
          value={INR(kpis.returnsValue)}
          sub="Σ net, negative-quantity rows"
        />
        <KpiCard label="Active channels" value={String(kpis.activeChannels)} />
        <KpiCard
          label="MoM growth"
          value={kpis.momPct === null ? "—" : `${kpis.momPct >= 0 ? "+" : ""}${kpis.momPct.toFixed(1)}%`}
          sub={kpis.priorMonth && kpis.latestMonth ? `${kpis.priorMonth.slice(0, 7)} → ${kpis.latestMonth.slice(0, 7)}` : "Needs 2+ months in scope"}
        />
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

      <div className="mt-6">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Channel Type breakdown</span>
        <p className="mt-1 text-[11.5px] text-ink-3">Primary view — every row in scope belongs to exactly one Channel Type, so this table's total equals the KPI cards above.</p>
        <div className="mt-2">
          <BreakdownTable rows={channelTypeRows} keyLabel="Channel Type" footerLabel="Total" emptyLabel="No rows match these filters." />
        </div>
      </div>

      <div className="mt-6">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Branch / warehouse breakdown</span>
        <div className="mt-2">
          <BreakdownTable rows={branchRows} keyLabel="Branch" footerLabel="Total" emptyLabel="No rows match these filters." />
        </div>
      </div>

      <div className="mt-6">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
          Top parties {allPartyRows.length > TOP_PARTIES_LIMIT ? `(top ${TOP_PARTIES_LIMIT} of ${allPartyRows.length})` : ""}
        </span>
        <p className="mt-1 text-[11.5px] text-ink-3">
          {allPartyRows.length} distinct part{allPartyRows.length === 1 ? "y" : "ies"} in scope — too many for a dropdown. Use the search box above to find one by name; it narrows this table (and every KPI/table on the page) the same way.
        </p>
        <div className="mt-2">
          <BreakdownTable
            rows={topPartyRows}
            keyLabel="Party"
            footerLabel={allPartyRows.length > TOP_PARTIES_LIMIT ? `Total — top ${topPartyRows.length} parties` : "Total"}
            emptyLabel="No parties match these filters."
          />
        </div>
      </div>

      <div className="mt-6">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Monthly trend — net sales</span>
        <div className="mt-2 border border-line-soft p-3">
          {trendPoints.length === 0 ? (
            <p className="py-10 text-center text-sm text-ink-3">No data in this month range / filter.</p>
          ) : (
            <TrendChart points={trendPoints} ariaLabel="Net sales by month, wholesale/distribution channels" />
          )}
        </div>
      </div>
    </>
  );
}
