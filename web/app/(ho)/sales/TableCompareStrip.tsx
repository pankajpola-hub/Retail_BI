import { KpiCard } from "@/components/ui/KpiCard";
import { DeltaBadge } from "@/components/ui/DeltaBadge";
import type { LineTotals, QtySplit } from "@/lib/sales/lineAggregates";

const INR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const NUM = (n: number) => n.toLocaleString("en-IN");

/**
 * Totals strip shown above a self-contained table while ITS OWN comparison is
 * active. Recomputed from summed parts for both windows by the same function
 * (computeTotalsFromLines), never a second parallel formula — the rule
 * rollUpCore and computeSalesTotals already follow for the page-level strips.
 *
 * Lifted out of page.tsx (2026-09-05) so the client-fetched "Period
 * comparison" block can render the identical strip. No "use client" of its
 * own: it holds no state and no handlers, so it compiles into whichever
 * bundle imports it — server for the table sections, client for that block.
 *
 * `split` is optional. Where it is given (the Period comparison block, whose
 * ENTIRE job is this comparison) three more cards carry the Fresh/EOSS/Total
 * unit split; where it is not, the strip is exactly the five cards it was.
 */
export function TableCompareStrip({
  current,
  comparison,
  compareFrom,
  compareTo,
  currentSplit,
  comparisonSplit,
}: {
  current: LineTotals;
  comparison: LineTotals;
  compareFrom: string;
  compareTo: string;
  currentSplit?: QtySplit;
  comparisonSplit?: QtySplit;
}) {
  const showSplit = Boolean(currentSplit && comparisonSplit);
  return (
    <div className="mb-3">
      <p className="mb-2 text-[11.5px] text-ink-3">
        This table only — vs {compareFrom} – {compareTo}
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard
          label="Net sales"
          value={INR(current.net)}
          delta={<DeltaBadge current={current.net} previous={comparison.net} baselineLabel={`vs ${INR(comparison.net)}`} />}
        />
        <KpiCard
          label="Sale bills"
          value={NUM(current.bills)}
          delta={<DeltaBadge current={current.bills} previous={comparison.bills} baselineLabel={`vs ${NUM(comparison.bills)}`} />}
        />
        <KpiCard
          label="Units"
          value={NUM(current.qty)}
          delta={<DeltaBadge current={current.qty} previous={comparison.qty} baselineLabel={`vs ${NUM(comparison.qty)}`} />}
        />
        <KpiCard
          label="ATV"
          value={current.atv !== null ? INR(current.atv) : "—"}
          delta={<DeltaBadge current={current.atv} previous={comparison.atv} baselineLabel={comparison.atv !== null ? `vs ${INR(comparison.atv)}` : "vs —"} />}
        />
        <KpiCard
          label="Discount %"
          value={current.discountPct !== null ? `${current.discountPct.toFixed(1)}%` : "—"}
          // A discount RATE is itself a percentage, so its change is shown in
          // percentage points, and a rising discount rate is bad news.
          delta={
            <DeltaBadge
              current={current.discountPct}
              previous={comparison.discountPct}
              mode="pp"
              invert
              baselineLabel={comparison.discountPct !== null ? `vs ${comparison.discountPct.toFixed(1)}%` : "vs —"}
            />
          }
        />
      </div>

      {showSplit && currentSplit && comparisonSplit && (
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <KpiCard
            label="Fresh qty"
            value={NUM(currentSplit.freshQty)}
            delta={<DeltaBadge current={currentSplit.freshQty} previous={comparisonSplit.freshQty} baselineLabel={`vs ${NUM(comparisonSplit.freshQty)}`} />}
            sub="Discount under 49.5% of gross"
          />
          <KpiCard
            label="EOSS qty"
            value={NUM(currentSplit.eossQty)}
            delta={<DeltaBadge current={currentSplit.eossQty} previous={comparisonSplit.eossQty} baselineLabel={`vs ${NUM(comparisonSplit.eossQty)}`} />}
            sub="Discount 49.5% of gross or more"
          />
          <KpiCard
            label="Total qty"
            value={NUM(currentSplit.totalQty)}
            delta={<DeltaBadge current={currentSplit.totalQty} previous={comparisonSplit.totalQty} baselineLabel={`vs ${NUM(comparisonSplit.totalQty)}`} />}
            sub="Fresh + EOSS, sale bills only"
          />
        </div>
      )}
    </div>
  );
}
