import { Suspense } from "react";
import { createClient } from "@/lib/data/client";
import type { DataClient } from "@/lib/data/client";
import { requirePageAccess } from "@/lib/auth/roles";
import { resolveAccess } from "@/lib/auth/access";
import { Input, Select, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { KpiGridSkeleton, TableSkeleton } from "@/components/ui/Skeleton";
import { SectionErrorBoundary } from "@/components/ui/SectionErrorBoundary";
import { time } from "@/lib/perf/timing";
import {
  computeReplenishmentRows,
  computeReplenishmentKpis,
  computeTopSupplyMoves,
  fmt,
  fmt1,
  type Trend,
  type ScoreWeights,
} from "@/lib/replenishment/compute";
import { computeSaleStockMix, type MixStatus, type SalesPeriodDays } from "@/lib/replenishment/mix";
import { ReplenishmentFacetedContent } from "./ReplenishmentFacetedContent";
import { SaleStockMixFacetedContent } from "./SaleStockMixFacetedContent";

export const dynamic = "force-dynamic";

// Movement = Replenishment + Sale vs Stock Mix, merged into one route
// (Phase 2 nav consolidation) — the two pages already shared a PageKey/gate
// and were already grouped under "Movement" in the sidebar, but shared
// almost no compute logic, so this merge is UI/routing only: both content
// blocks below are the two original pages' content, moved essentially
// verbatim. The one real risk was param collision (both used identical
// store/page/perPage names) — resolved by namespacing every Sale vs Stock
// Mix param with a `mix_` prefix, so both tabs stay independently
// addressable in the URL at once and switching tabs never loses the other
// tab's filters.

function inr(n: number): string {
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}

const TREND_META: Record<Trend, { label: string; className: string }> = {
  accelerating: { label: "↑ Accelerating", className: "text-good" },
  stable: { label: "→ Stable", className: "text-ink-3" },
  declining: { label: "↓ Declining", className: "text-crit" },
};

function KpiCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "warn" | "crit" | "good" }) {
  return (
    <div className="border border-line-soft bg-surface px-4 pb-3 pt-3.5">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.11em] text-ink-3">{label}</div>
      <div
        className={`mt-1.5 font-mono text-2xl tracking-tight ${
          tone === "crit" ? "text-crit" : tone === "warn" ? "text-warn" : tone === "good" ? "text-good" : "text-ink"
        }`}
      >
        {value}
      </div>
      {sub ? <div className="mt-1 text-[11.5px] text-ink-3">{sub}</div> : null}
    </div>
  );
}

type MovementSearchParams = {
  tab?: string;
  // Replenishment tab — unprefixed, unchanged from the standalone page.
  q?: string;
  store?: string;
  priority?: string;
  action?: string;
  targetCover?: string;
  leadTime?: string;
  safetyDays?: string;
  wStockout?: string;
  wVelocity?: string;
  wCover?: string;
  wRevenue?: string;
  wTrend?: string;
  wProductivity?: string;
  page?: string;
  perPage?: string;
  // Sale vs Stock Mix tab — mix_-prefixed so nothing above can collide.
  mix_store?: string;
  mix_style?: string;
  mix_color?: string;
  mix_period?: string;
  mix_status?: string;
  mix_page?: string;
  mix_perPage?: string;
};

// Preserves every param already in the URL (both tabs' state) and only
// changes `tab` — so switching tabs never loses the other tab's filters.
function tabHref(searchParams: MovementSearchParams, tab: "replenishment" | "mix"): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams)) {
    if (v) params.set(k, String(v));
  }
  params.set("tab", tab);
  return `?${params.toString()}`;
}

function ReplenishmentSkeleton() {
  return (
    <>
      <KpiGridSkeleton count={8} />
      <div className="mt-6">
        <TableSkeleton rows={6} cols={10} />
      </div>
      <div className="mt-6">
        <TableSkeleton rows={8} cols={14} />
      </div>
    </>
  );
}

/**
 * Everything past the intro comes from ONE call to computeReplenishmentRows
 * — the network allocation engine — so this is one Suspense boundary, same
 * as when this lived at /replenishment.
 */
async function ReplenishmentContent({
  supabase,
  searchParams,
}: {
  supabase: DataClient;
  searchParams: MovementSearchParams;
}) {
  // Feature gates (0079) — cached per request, so this is free alongside the
  // page-level check the route already did.
  const access = await resolveAccess();
  if (!access) return null;

  const targetCoverDays = Number(searchParams.targetCover) > 0 ? Number(searchParams.targetCover) : 21;
  const leadTimeDays = Number(searchParams.leadTime) > 0 ? Number(searchParams.leadTime) : 5;
  const safetyDays = Number(searchParams.safetyDays) >= 0 ? Number(searchParams.safetyDays) : 3;
  const nonNegNum = (v: string | undefined, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const SCORE_W: ScoreWeights = {
    stockoutRisk: nonNegNum(searchParams.wStockout, 25),
    velocity: nonNegNum(searchParams.wVelocity, 25),
    cover: nonNegNum(searchParams.wCover, 15),
    salesValue: nonNegNum(searchParams.wRevenue, 15),
    trend: nonNegNum(searchParams.wTrend, 10),
    productivity: nonNegNum(searchParams.wProductivity, 10),
  };

  const { rows, totalWarehouseUnits } = await time(
    "replenishment:compute",
    computeReplenishmentRows(supabase, {
      targetCoverDays,
      leadTimeDays,
      safetyDays,
      scoreWeights: SCORE_W,
    })
  );

  // Display filtering/search/pagination is no longer server-side for this
  // tab (Phase 1 of the faceted-filtering system —
  // ReplenishmentFacetedContent.tsx does it instantly, client-side, over
  // the full row set below). Only the recompute inputs (what-if
  // assumptions, priority weights) still round-trip the server, since
  // those change the actual numbers.
  function buildHref(overrides: Record<string, string | number>): string {
    const params = new URLSearchParams();
    const current: Record<string, string | undefined> = {
      tab: "replenishment",
      targetCover: String(targetCoverDays),
      leadTime: String(leadTimeDays),
      safetyDays: String(safetyDays),
      wStockout: String(SCORE_W.stockoutRisk),
      wVelocity: String(SCORE_W.velocity),
      wCover: String(SCORE_W.cover),
      wRevenue: String(SCORE_W.salesValue),
      wTrend: String(SCORE_W.trend),
      wProductivity: String(SCORE_W.productivity),
      mix_store: searchParams.mix_store,
      mix_style: searchParams.mix_style,
      mix_color: searchParams.mix_color,
      mix_period: searchParams.mix_period,
      mix_status: searchParams.mix_status,
      mix_page: searchParams.mix_page,
      mix_perPage: searchParams.mix_perPage,
    };
    for (const [k, v] of Object.entries(current)) if (v) params.set(k, v);
    for (const [k, v] of Object.entries(overrides)) params.set(k, String(v));
    return `?${params.toString()}`;
  }

  // Download regenerates the full network dataset server-side for the
  // current what-if/weight inputs — it does NOT know the client-side
  // facet/search state (that's purely in the browser), so it always
  // exports everything for those inputs, not just what's currently
  // visible after faceting. Documented behavior change from before this
  // phase, when q/store/priority/action were server params the download
  // route could read directly.
  const downloadHref = (() => {
    const params = new URLSearchParams();
    params.set("targetCover", String(targetCoverDays));
    params.set("leadTime", String(leadTimeDays));
    params.set("safetyDays", String(safetyDays));
    params.set("wStockout", String(SCORE_W.stockoutRisk));
    params.set("wVelocity", String(SCORE_W.velocity));
    params.set("wCover", String(SCORE_W.cover));
    params.set("wRevenue", String(SCORE_W.salesValue));
    params.set("wTrend", String(SCORE_W.trend));
    params.set("wProductivity", String(SCORE_W.productivity));
    return `/api/replenishment/download?${params.toString()}`;
  })();

  const { needsReplenishment, unitsRequired, criticalCount, storesAtRisk, transferCount, purchaseCount, exhaustedCount } =
    computeReplenishmentKpis(rows);
  const { top: top10, salesProtected } = computeTopSupplyMoves(rows, 10);

  return (
    <>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <KpiCard label="Style-colors needing replenishment" value={fmt(needsReplenishment)} />
        <KpiCard label="Units required" value={fmt(unitsRequired)} />
        <KpiCard label="Critical" value={fmt(criticalCount)} tone={criticalCount > 0 ? "crit" : undefined} />
        <KpiCard label="Stores at stock-out risk" value={fmt(storesAtRisk)} tone={storesAtRisk > 0 ? "warn" : undefined} />
        <KpiCard label="Warehouse available" value={fmt(totalWarehouseUnits)} sub="units, all style-colors" />
        <KpiCard label="Transfer opportunities" value={fmt(transferCount)} />
        <KpiCard label="Purchase (needs review)" value={fmt(purchaseCount)} />
        <KpiCard label="Exhausted (no network stock)" value={fmt(exhaustedCount)} />
      </div>

      {top10.length > 0 && (
        <div className="mt-6 border border-line-soft p-4">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">Where should we send stock?</span>
          <p className="mt-1 text-[12px] text-ink-3">
            Top 10 supply moves, ranked by priority score.{" "}
            {salesProtected > 0 && (
              <>
                Potential sales protected by making these moves:{" "}
                <strong className="text-ink-2">{inr(salesProtected)}</strong> — an estimate from recent sales
                velocity and available stock, not a guarantee.
              </>
            )}
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[820px] text-[12.5px]">
              <thead>
                <tr className="border-b border-line-soft text-left text-[10px] uppercase tracking-wide text-ink-3">
                  <th className="px-2 py-1.5">Rank</th>
                  <th className="px-2 py-1.5">Style</th>
                  <th className="px-2 py-1.5">Color</th>
                  <th className="px-2 py-1.5">Store</th>
                  <th className="px-2 py-1.5 text-right">Sales 30D</th>
                  <th className="px-2 py-1.5 text-right">Velocity</th>
                  <th className="px-2 py-1.5 text-right">SOH</th>
                  <th className="px-2 py-1.5 text-right">Cover</th>
                  <th className="px-2 py-1.5">Trend</th>
                  <th className="px-2 py-1.5 text-right">Recommended</th>
                </tr>
              </thead>
              <tbody>
                {top10.map((r, i) => (
                  <tr key={`${r.storeId}-${r.styleNo}-${r.color}`} className="border-b border-line-soft last:border-0">
                    <td className="px-2 py-1.5 font-mono text-ink-3">{i + 1}</td>
                    <td className="px-2 py-1.5 font-mono text-[11.5px]">{r.styleNo}</td>
                    <td className="px-2 py-1.5 text-ink-2">{r.color}</td>
                    <td className="px-2 py-1.5 text-ink-2">{r.storeName}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{fmt(r.sales30d)}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{fmt1(r.dailyDemand)}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{fmt(r.soh)}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{r.coverDays === null ? "—" : `${fmt1(r.coverDays)}d`}</td>
                    <td className={`px-2 py-1.5 ${r.trend ? TREND_META[r.trend].className : ""}`}>
                      {r.trend ? TREND_META[r.trend].label : "—"}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono font-semibold">{fmt(r.recommendedQty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Both <details> forms below are gated by one 'edit' key: they change
          the numbers the engine produces (a server recompute), not merely
          which rows are shown. */}
      {access.can("replenishment.whatif.edit") && (
      <>
      <details className="mt-4 border border-line-soft p-4">
        <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-ink-2">
          Assumptions (what-if) — target cover {targetCoverDays}d · lead time {leadTimeDays}d · safety {safetyDays}d
        </summary>
        <form className="mt-3 flex flex-wrap items-end gap-4 text-[12.5px]">
          <input type="hidden" name="tab" value="replenishment" />
          <input type="hidden" name="wStockout" value={SCORE_W.stockoutRisk} />
          <input type="hidden" name="wVelocity" value={SCORE_W.velocity} />
          <input type="hidden" name="wCover" value={SCORE_W.cover} />
          <input type="hidden" name="wRevenue" value={SCORE_W.salesValue} />
          <input type="hidden" name="wTrend" value={SCORE_W.trend} />
          <input type="hidden" name="wProductivity" value={SCORE_W.productivity} />
          <Label className="flex flex-col gap-1">
            Target cover (days)
            <Input type="number" name="targetCover" min={1} defaultValue={targetCoverDays} className="w-24" />
          </Label>
          <Label className="flex flex-col gap-1">
            Lead time (days)
            <Input type="number" name="leadTime" min={0} defaultValue={leadTimeDays} className="w-24" />
          </Label>
          <Label className="flex flex-col gap-1">
            Safety stock (days)
            <Input type="number" name="safetyDays" min={0} defaultValue={safetyDays} className="w-24" />
          </Label>
          <Button type="submit">Recalculate</Button>
        </form>
      </details>

      <details className="mt-4 border border-line-soft p-4">
        <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-ink-2">
          Priority score factors — what decides which style-color gets served first
        </summary>
        <p className="mt-2 max-w-3xl text-[12px] text-ink-3">
          Every row&apos;s Priority and Score are built from these six factors, blended together. Raise a factor&apos;s
          weight to make it matter more to the final ranking; lower it to matter less. They don&apos;t need to add up
          to exactly 100 — they&apos;re compared to each other, not to a fixed total.
        </p>
        <form className="mt-3 grid grid-cols-1 gap-4 text-[12.5px] sm:grid-cols-2 lg:grid-cols-3">
          <input type="hidden" name="tab" value="replenishment" />
          <input type="hidden" name="targetCover" value={targetCoverDays} />
          <input type="hidden" name="leadTime" value={leadTimeDays} />
          <input type="hidden" name="safetyDays" value={safetyDays} />

          <div>
            <Label className="flex items-center justify-between gap-2 font-semibold text-ink-2">
              Stock-out risk
              <Input type="number" name="wStockout" min={0} max={100} defaultValue={SCORE_W.stockoutRisk} className="w-16 text-right" />
              %
            </Label>
            <p className="mt-1 text-[11.5px] text-ink-3">
              How soon a store will actually run out, given how long a reorder takes to arrive. A store about to hit
              zero gets pushed to the top of the list even if its stock number alone doesn&apos;t look dramatic.
            </p>
          </div>

          <div>
            <Label className="flex items-center justify-between gap-2 font-semibold text-ink-2">
              Demand velocity
              <Input type="number" name="wVelocity" min={0} max={100} defaultValue={SCORE_W.velocity} className="w-16 text-right" />
              %
            </Label>
            <p className="mt-1 text-[11.5px] text-ink-3">
              How fast this style-color is actually selling right now. A fast seller with low stock is treated as
              more urgent than a slow seller with the same low stock.
            </p>
          </div>

          <div>
            <Label className="flex items-center justify-between gap-2 font-semibold text-ink-2">
              Days of cover
              <Input type="number" name="wCover" min={0} max={100} defaultValue={SCORE_W.cover} className="w-16 text-right" />
              %
            </Label>
            <p className="mt-1 text-[11.5px] text-ink-3">
              How many days the current stock will last compared to the target cover you set above. The further
              short of target a store is, the higher this pushes its priority.
            </p>
          </div>

          <div>
            <Label className="flex items-center justify-between gap-2 font-semibold text-ink-2">
              Revenue potential
              <Input type="number" name="wRevenue" min={0} max={100} defaultValue={SCORE_W.salesValue} className="w-16 text-right" />
              %
            </Label>
            <p className="mt-1 text-[11.5px] text-ink-3">
              How much money this style-color actually earns per day at this store. Raise this to send scarce stock
              toward the styles/stores that protect the most revenue, not just the ones selling the most units.
            </p>
          </div>

          <div>
            <Label className="flex items-center justify-between gap-2 font-semibold text-ink-2">
              Sales trend
              <Input type="number" name="wTrend" min={0} max={100} defaultValue={SCORE_W.trend} className="w-16 text-right" />
              %
            </Label>
            <p className="mt-1 text-[11.5px] text-ink-3">
              Whether sales are speeding up, holding steady, or slowing down (last 7 days vs. last 30). An
              accelerating style gets a boost; a declining one gets pushed down so you don&apos;t over-stock something
              on its way out.
            </p>
          </div>

          <div>
            <Label className="flex items-center justify-between gap-2 font-semibold text-ink-2">
              Store productivity
              <Input type="number" name="wProductivity" min={0} max={100} defaultValue={SCORE_W.productivity} className="w-16 text-right" />
              %
            </Label>
            <p className="mt-1 text-[11.5px] text-ink-3">
              How much this store contributes to total sales overall. When two stores are competing for the same
              limited stock, your busier/higher-performing store gets a slight edge.
            </p>
          </div>

          <div className="sm:col-span-2 lg:col-span-3">
            <Button type="submit">Recalculate priorities</Button>
          </div>
        </form>
      </details>
      </>
      )}

      {/* An 'export' key — this pulls the full network dataset out of the app,
          which is exactly the kind of thing worth being able to revoke
          independently of read access. NOTE the API route itself
          (/api/replenishment/download) still needs its own check; hiding the
          link is view tailoring, not enforcement. */}
      {access.can("replenishment.recommendations.export") && (
        <div className="mt-4 flex justify-end">
          <a href={downloadHref} className="min-h-[30px] border border-line px-3 py-1 text-[12px] text-ink-2 hover:bg-surface-2">
            Download full report (.xlsx)
          </a>
        </div>
      )}

      <div className="mt-3">
        <ReplenishmentFacetedContent rows={rows} />
      </div>
    </>
  );
}

const PERIOD_OPTIONS: SalesPeriodDays[] = [7, 30, 60, 90];

function SaleStockMixSkeleton() {
  return (
    <>
      <KpiGridSkeleton count={5} />
      <div className="mt-6">
        <TableSkeleton rows={8} cols={9} />
      </div>
    </>
  );
}

/**
 * Same shape as ReplenishmentContent — one computeSaleStockMix() call feeds
 * everything. Reads/writes are all mix_-prefixed (see the file header) so
 * this tab's state never collides with the Replenishment tab's.
 */
async function SaleStockMixContent({
  supabase,
  searchParams,
}: {
  supabase: DataClient;
  searchParams: MovementSearchParams;
}) {
  // `store` and `salesPeriodDays` stay real server params — unlike
  // Replenishment's old q/store/priority/action, computeSaleStockMix
  // genuinely AGGREGATES at the store scope (storeId="" means network-wide
  // totals per style-color, not "all stores' own rows together" — see
  // lib/replenishment/mix.ts's own comments), so there's no per-store
  // breakdown to facet over client-side without changing what gets
  // computed. Style/Color/Status were already plain post-filters on the
  // fetched rows — those move to SaleStockMixFacetedContent.tsx instead
  // (Phase 1 of the faceted-filtering system, second page after
  // Replenishment).
  const storeId = searchParams.mix_store ?? "";
  const periodParam = Number(searchParams.mix_period) as SalesPeriodDays;
  const salesPeriodDays: SalesPeriodDays = PERIOD_OPTIONS.includes(periodParam) ? periodParam : 30;

  const { storeList, rows, totalSales, totalStock } = await time(
    "sale-stock-mix:compute",
    computeSaleStockMix(supabase, { storeId, salesPeriodDays })
  );

  const counts: Record<MixStatus, number> = {
    high_priority: 0,
    opportunity: 0,
    balanced: 0,
    stock_heavy: 0,
    overstocked: 0,
  };
  for (const r of rows) counts[r.status]++;

  return (
    <>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard label="High priority" value={fmt(counts.high_priority)} tone={counts.high_priority > 0 ? "crit" : undefined} />
        <KpiCard label="Allocation opportunities" value={fmt(counts.opportunity)} tone={counts.opportunity > 0 ? "good" : undefined} />
        <KpiCard label="Balanced" value={fmt(counts.balanced)} />
        <KpiCard label="Stock heavy" value={fmt(counts.stock_heavy)} tone={counts.stock_heavy > 0 ? "warn" : undefined} />
        <KpiCard label="Overstocked" value={fmt(counts.overstocked)} tone={counts.overstocked > 0 ? "crit" : undefined} />
      </div>

      <details className="mt-4 border border-line-soft p-4">
        <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-ink-2">
          How this is calculated
        </summary>
        <div className="mt-2 max-w-2xl space-y-1.5 text-[12px] text-ink-3">
          <p>
            <strong className="text-ink-2">Sale Mix %</strong> = this style-color&apos;s net units sold (last{" "}
            {salesPeriodDays} days) ÷ total net units sold across all style-colors in the same scope, ×100.
          </p>
          <p>
            <strong className="text-ink-2">Stock Mix %</strong> = this style-color&apos;s current store stock ÷ total
            current store stock across all style-colors in the same scope, ×100. Warehouse bulk stock is tracked
            separately and shown as a availability check, not mixed into this percentage.
          </p>
          <p>
            <strong className="text-ink-2">Mix Gap</strong> = Sale Mix % − Stock Mix %, in percentage points (pp),
            not percentage growth. Positive = selling faster than its stock share; negative = holding more stock than
            it sells.
          </p>
          <p>Total sales in scope: {fmt(totalSales)} units · Total store stock in scope: {fmt(totalStock)} units.</p>
        </div>
      </details>

      <form className="mt-4 flex flex-wrap items-end gap-3 text-[12.5px]">
        <input type="hidden" name="tab" value="mix" />
        {/* Preserves the Replenishment tab's own server params across this
            form's native GET submit — same "don't lose the other tab's
            state" principle as tabHref/buildHref elsewhere in this file. */}
        <input type="hidden" name="targetCover" value={searchParams.targetCover ?? ""} />
        <input type="hidden" name="leadTime" value={searchParams.leadTime ?? ""} />
        <input type="hidden" name="safetyDays" value={searchParams.safetyDays ?? ""} />
        <input type="hidden" name="wStockout" value={searchParams.wStockout ?? ""} />
        <input type="hidden" name="wVelocity" value={searchParams.wVelocity ?? ""} />
        <input type="hidden" name="wCover" value={searchParams.wCover ?? ""} />
        <input type="hidden" name="wRevenue" value={searchParams.wRevenue ?? ""} />
        <input type="hidden" name="wTrend" value={searchParams.wTrend ?? ""} />
        <input type="hidden" name="wProductivity" value={searchParams.wProductivity ?? ""} />
        <Label className="flex flex-col gap-1">
          Store
          <Select name="mix_store" defaultValue={storeId}>
            <option value="">All stores</option>
            {storeList.map((s) => (
              <option key={s.store_id} value={s.store_id}>
                {s.store_name}
              </option>
            ))}
          </Select>
        </Label>
        <Label className="flex flex-col gap-1">
          Sales period
          <Select name="mix_period" defaultValue={String(salesPeriodDays)}>
            {PERIOD_OPTIONS.map((p) => (
              <option key={p} value={p}>
                Last {p} days
              </option>
            ))}
          </Select>
        </Label>
        <Button type="submit" variant="outline">Apply</Button>
      </form>

      <div className="mt-4">
        <SaleStockMixFacetedContent rows={rows} />
      </div>
    </>
  );
}

export default async function MovementPage({
  searchParams,
}: {
  searchParams: MovementSearchParams;
}) {
  await requirePageAccess("replenishment");
  const supabase = await createClient();
  // Feature gates (0079). The two tabs are separately grantable, so the
  // requested tab has to be reconciled against what the caller can actually
  // see: landing on a denied tab falls back to the other one rather than
  // rendering an empty page, and a tab they can't see isn't offered as a link.
  const access = await resolveAccess();
  const canRepl = access?.can("replenishment.recommendations.view") ?? true;
  const canMix = access?.can("replenishment.mix.view") ?? true;

  const requested = searchParams.tab === "mix" ? "mix" : "replenishment";
  const tab = requested === "mix" ? (canMix ? "mix" : "replenishment") : canRepl ? "replenishment" : "mix";

  return (
    <main className="py-6">
      <h1 className="font-serif text-2xl">Movement</h1>
      <p className="mt-1 max-w-3xl text-[12.5px] text-ink-3">
        Replenishment recommendations and Sale vs Stock Mix — meant to be read together, not as competing answers.
      </p>

      {!canRepl && !canMix ? (
        <p className="mt-6 border-l-2 border-warn bg-warn-soft px-3 py-2 text-sm text-ink-2">
          You don&apos;t have access to either section of this page. Ask a super admin if you think you should.
        </p>
      ) : (
      <>
      <div className="mt-4 flex gap-1 border-b border-line-soft text-[13px]">
        {canRepl && (
        <a
          href={tabHref(searchParams, "replenishment")}
          className={`border-b-2 px-3 py-2 ${
            tab === "replenishment" ? "border-accent font-semibold text-ink" : "border-transparent text-ink-3 hover:text-ink-2"
          }`}
        >
          Replenishment
        </a>
        )}
        {canMix && (
        <a
          href={tabHref(searchParams, "mix")}
          className={`border-b-2 px-3 py-2 ${
            tab === "mix" ? "border-accent font-semibold text-ink" : "border-transparent text-ink-3 hover:text-ink-2"
          }`}
        >
          Sale vs Stock Mix
        </a>
        )}
      </div>

      {tab === "replenishment" ? (
        <>
          <p className="mt-3 max-w-3xl text-[12.5px] text-ink-3">
            Warehouse → Store and Store → Store recommendations, by <strong>Style No. + Color</strong>, allocated
            network-wide — when two stores compete for the same limited warehouse stock, the higher-priority store
            (by sales velocity, stock-out risk, and trend) is served first, not split evenly. Priority score and
            weighted sales velocity use configurable assumptions below, not measured vendor lead times — no
            purchase-order or vendor lead-time data exists in the system yet.
          </p>
          <SectionErrorBoundary label="Replenishment recommendations">
            <Suspense fallback={<ReplenishmentSkeleton />}>
              <ReplenishmentContent supabase={supabase} searchParams={searchParams} />
            </Suspense>
          </SectionErrorBoundary>
        </>
      ) : (
        <>
          <p className="mt-3 max-w-3xl text-[12.5px] text-ink-3">
            By <strong>Style No. + Color</strong>: what share of recent sales does this style-color earn, versus
            what share of current stock it&apos;s holding? A style-color selling faster than its stock share
            suggests allocation is warranted; one holding more stock than it sells suggests the opposite.
          </p>
          <SectionErrorBoundary label="Sale Mix vs Stock Mix">
            <Suspense fallback={<SaleStockMixSkeleton />}>
              <SaleStockMixContent supabase={supabase} searchParams={searchParams} />
            </Suspense>
          </SectionErrorBoundary>
        </>
      )}
      </>
      )}
    </main>
  );
}
