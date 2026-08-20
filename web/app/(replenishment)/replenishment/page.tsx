import { Suspense } from "react";
import { createClient } from "@/lib/data/client";
import type { DataClient } from "@/lib/data/client";
import { requirePageAccess } from "@/lib/auth/roles";
import { RowsPerPageSelect } from "@/components/ui/RowsPerPageSelect";
import { Input, Select, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { KpiGridSkeleton, TableSkeleton } from "@/components/ui/Skeleton";
import { SectionErrorBoundary } from "@/components/ui/SectionErrorBoundary";
import { time } from "@/lib/perf/timing";
import {
  computeReplenishmentRows,
  computeReplenishmentKpis,
  computeTopSupplyMoves,
  filterRows,
  fmt,
  fmt1,
  PRIORITY_ORDER,
  type Priority,
  type Trend,
  type Action,
  type ScoreWeights,
} from "@/lib/replenishment/compute";
import { ReplenishmentGrid } from "./ReplenishmentGrid";

export const dynamic = "force-dynamic";

function inr(n: number): string {
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}

const PRIORITY_META: Record<Priority, { label: string; dot: string; className: string }> = {
  critical: { label: "Critical", dot: "🔴", className: "text-crit font-semibold" },
  high: { label: "High", dot: "🟠", className: "text-warn font-semibold" },
  medium: { label: "Medium", dot: "🟡", className: "text-ink-2" },
  healthy: { label: "Healthy", dot: "🟢", className: "text-good" },
  exhausted: { label: "Exhausted", dot: "⚫", className: "text-ink-3" },
};
const TREND_META: Record<Trend, { label: string; className: string }> = {
  accelerating: { label: "↑ Accelerating", className: "text-good" },
  stable: { label: "→ Stable", className: "text-ink-3" },
  declining: { label: "↓ Declining", className: "text-crit" },
};

function KpiCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "warn" | "crit" }) {
  return (
    <div className="border border-line-soft bg-surface px-4 pb-3 pt-3.5">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.11em] text-ink-3">{label}</div>
      <div
        className={`mt-1.5 font-mono text-2xl tracking-tight ${
          tone === "crit" ? "text-crit" : tone === "warn" ? "text-warn" : "text-ink"
        }`}
      >
        {value}
      </div>
      {sub ? <div className="mt-1 text-[11.5px] text-ink-3">{sub}</div> : null}
    </div>
  );
}

type ReplenishmentSearchParams = {
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
};

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
 * Everything on this page past the intro paragraph comes from ONE call to
 * computeReplenishmentRows() — the network allocation engine — so unlike
 * Network/Stock-Details there's no independent visual region to split
 * further without literally re-running that expensive computation twice.
 * This whole block is one Suspense boundary; the page shell above it
 * (title, intro) renders instantly regardless of how long the engine takes.
 */
async function ReplenishmentContent({
  supabase,
  searchParams,
}: {
  supabase: DataClient;
  searchParams: ReplenishmentSearchParams;
}) {
  // --- Configurable assumptions (the "what-if" inputs). No real vendor/PO
  // lead-time data exists yet (see the page's own disclosure text below), so
  // these are sane defaults the user can override per visit rather than
  // numbers pretending to be measured. ---
  const targetCoverDays = Number(searchParams.targetCover) > 0 ? Number(searchParams.targetCover) : 21;
  const leadTimeDays = Number(searchParams.leadTime) > 0 ? Number(searchParams.leadTime) : 5;
  const safetyDays = Number(searchParams.safetyDays) >= 0 ? Number(searchParams.safetyDays) : 3;
  // Priority-score factor weights — user-adjustable below the table. Each
  // number here is a PERCENTAGE (0-100); they're normalized by their own sum
  // at use time (see scoreOf in lib/replenishment/compute.ts), so they don't
  // have to add up to exactly 100 for the math to stay correct.
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

  // Network allocation engine — see lib/replenishment/compute.ts. Shared with
  // web/app/api/replenishment/download/route.ts so the Excel export always
  // matches exactly what this page computes for the same query params.
  const { storeList, rows, totalWarehouseUnits } = await time(
    "replenishment:compute",
    computeReplenishmentRows(supabase, {
      targetCoverDays,
      leadTimeDays,
      safetyDays,
      scoreWeights: SCORE_W,
    })
  );

  // --- Filters (applied after computation, since priority/action are derived, not DB columns) ---
  const q = searchParams.q ?? "";
  const storeFilter = searchParams.store ?? "";
  const priorityFilter = searchParams.priority ?? "";
  const actionFilter = searchParams.action ?? "";

  const filtered = filterRows(rows, { q, store: storeFilter, priority: priorityFilter, action: actionFilter });
  filtered.sort((a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority) || b.score - a.score);

  // --- Pagination (replaces the old flat "first 500 rows" cap). perPage is
  // one of PER_PAGE_OPTIONS or "max" (everything in one page); page numbers
  // are 1-based and clamped into range so a stale ?page= from before a
  // filter change (which can shrink totalPages) never lands past the end.
  const PER_PAGE_OPTIONS = ["10", "50", "100", "max"];
  const perPageParam = PER_PAGE_OPTIONS.includes(searchParams.perPage ?? "") ? (searchParams.perPage as string) : "50";
  const totalRows = filtered.length;
  const perPageNum = perPageParam === "max" ? Math.max(1, totalRows) : Number(perPageParam);
  const totalPages = Math.max(1, Math.ceil(totalRows / perPageNum));
  const page = Math.min(totalPages, Math.max(1, Number(searchParams.page) || 1));
  const pageStart = (page - 1) * perPageNum;
  const pageRows = filtered.slice(pageStart, pageStart + perPageNum);

  // Builds an href for the current page preserving every filter/assumption/
  // weight param already in the URL, only overriding the ones passed in —
  // used by the pager's Prev/Next/page-number links (plain <a> tags, same
  // full-navigation pattern the filter/assumptions forms already use, so no
  // client component is needed just to change a page number).
  function buildHref(overrides: Record<string, string | number>): string {
    const params = new URLSearchParams();
    const current: Record<string, string | undefined> = {
      q: searchParams.q,
      store: storeFilter || undefined,
      priority: priorityFilter || undefined,
      action: actionFilter || undefined,
      targetCover: String(targetCoverDays),
      leadTime: String(leadTimeDays),
      safetyDays: String(safetyDays),
      wStockout: String(SCORE_W.stockoutRisk),
      wVelocity: String(SCORE_W.velocity),
      wCover: String(SCORE_W.cover),
      wRevenue: String(SCORE_W.salesValue),
      wTrend: String(SCORE_W.trend),
      wProductivity: String(SCORE_W.productivity),
      perPage: perPageParam,
      page: String(page),
    };
    for (const [k, v] of Object.entries(current)) if (v) params.set(k, v);
    for (const [k, v] of Object.entries(overrides)) params.set(k, String(v));
    return `?${params.toString()}`;
  }

  // Same filter/assumption/weight params as buildHref, minus page/perPage —
  // the download always regenerates the FULL filtered dataset server-side,
  // not just whatever page is currently on screen.
  const downloadHref = (() => {
    const params = new URLSearchParams(buildHref({}).slice(1));
    params.delete("page");
    params.delete("perPage");
    const qs = params.toString();
    return `/api/replenishment/download${qs ? `?${qs}` : ""}`;
  })();

  // KPIs and the "Where should we send stock?" top-10 moves now live in
  // lib/replenishment/compute.ts's computeReplenishmentKpis()/
  // computeTopSupplyMoves() (2026-08-20) — moved verbatim so the Workspace
  // Builder's replenishment_kpi_grid/top_supply_moves_table call the same
  // functions this page does.
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

      {/* --- Where should we send stock? --- */}
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

      {/* --- What-if assumptions --- */}
      <details className="mt-4 border border-line-soft p-4">
        <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-ink-2">
          Assumptions (what-if) — target cover {targetCoverDays}d · lead time {leadTimeDays}d · safety {safetyDays}d
        </summary>
        <form className="mt-3 flex flex-wrap items-end gap-4 text-[12.5px]">
          <input type="hidden" name="q" value={searchParams.q ?? ""} />
          <input type="hidden" name="store" value={storeFilter} />
          <input type="hidden" name="priority" value={priorityFilter} />
          <input type="hidden" name="action" value={actionFilter} />
          <input type="hidden" name="wStockout" value={SCORE_W.stockoutRisk} />
          <input type="hidden" name="wVelocity" value={SCORE_W.velocity} />
          <input type="hidden" name="wCover" value={SCORE_W.cover} />
          <input type="hidden" name="wRevenue" value={SCORE_W.salesValue} />
          <input type="hidden" name="wTrend" value={SCORE_W.trend} />
          <input type="hidden" name="wProductivity" value={SCORE_W.productivity} />
          <input type="hidden" name="perPage" value={perPageParam} />
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

      {/* --- Priority score factor weights --- */}
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
          <input type="hidden" name="q" value={searchParams.q ?? ""} />
          <input type="hidden" name="store" value={storeFilter} />
          <input type="hidden" name="priority" value={priorityFilter} />
          <input type="hidden" name="action" value={actionFilter} />
          <input type="hidden" name="targetCover" value={targetCoverDays} />
          <input type="hidden" name="leadTime" value={leadTimeDays} />
          <input type="hidden" name="safetyDays" value={safetyDays} />
          <input type="hidden" name="perPage" value={perPageParam} />

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

      {/* --- Filters --- */}
      <form className="mt-4 flex flex-wrap items-end gap-3 text-[12.5px]">
        <input type="hidden" name="targetCover" value={targetCoverDays} />
        <input type="hidden" name="leadTime" value={leadTimeDays} />
        <input type="hidden" name="safetyDays" value={safetyDays} />
        <input type="hidden" name="wStockout" value={SCORE_W.stockoutRisk} />
        <input type="hidden" name="wVelocity" value={SCORE_W.velocity} />
        <input type="hidden" name="wCover" value={SCORE_W.cover} />
        <input type="hidden" name="wRevenue" value={SCORE_W.salesValue} />
        <input type="hidden" name="wTrend" value={SCORE_W.trend} />
        <input type="hidden" name="wProductivity" value={SCORE_W.productivity} />
        <input type="hidden" name="perPage" value={perPageParam} />
        <Label className="flex flex-col gap-1">
          Search style / color
          <Input type="text" name="q" defaultValue={searchParams.q ?? ""} placeholder="style no. or color" className="w-52" />
        </Label>
        <Label className="flex flex-col gap-1">
          Store
          <Select name="store" defaultValue={storeFilter}>
            <option value="">All stores</option>
            {storeList.map((s) => (
              <option key={s.store_id} value={s.store_id}>
                {s.store_name}
              </option>
            ))}
          </Select>
        </Label>
        <Label className="flex flex-col gap-1">
          Priority
          <Select name="priority" defaultValue={priorityFilter}>
            <option value="">All</option>
            {PRIORITY_ORDER.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_META[p].label}
              </option>
            ))}
          </Select>
        </Label>
        <Label className="flex flex-col gap-1">
          Action
          <Select name="action" defaultValue={actionFilter}>
            <option value="">All</option>
            {(
              [
                "REPLENISH FROM WAREHOUSE",
                "TRANSFER FROM STORE",
                "PURCHASE",
                "MONITOR",
                "DO NOT REPLENISH",
                "NO ACTION",
                "EXHAUSTED",
              ] as Action[]
            ).map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
        </Label>
        <Button type="submit" variant="outline">Apply</Button>
      </form>

      {/* --- Main table --- */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <span className="text-[12px] text-ink-3">
          {totalRows === 0 ? "0 rows" : `Showing ${fmt(pageStart + 1)}–${fmt(Math.min(pageStart + perPageNum, totalRows))} of ${fmt(totalRows)} rows`}
        </span>
        <span className="flex items-center gap-3">
          <RowsPerPageSelect selected={perPageParam} />
          <a
            href={downloadHref}
            className="min-h-[30px] border border-line px-3 py-1 text-[12px] text-ink-2 hover:bg-surface-2"
          >
            Download detailed report (.xlsx)
          </a>
        </span>
      </div>
      <ReplenishmentGrid rows={pageRows} />

      {/* --- Pager --- */}
      {totalPages > 1 && (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-1 text-[12.5px]">
          <a
            href={buildHref({ page: Math.max(1, page - 1) })}
            aria-disabled={page <= 1}
            className={`border border-line px-3 py-1 ${page <= 1 ? "pointer-events-none opacity-40" : "text-ink-2 hover:bg-surface-2"}`}
          >
            ← Prev
          </a>
          {Array.from({ length: totalPages }, (_, i) => i + 1)
            .filter((p) => p === 1 || p === totalPages || Math.abs(p - page) <= 2)
            .map((p, i, arr) => (
              <span key={p} className="flex items-center gap-1">
                {i > 0 && arr[i - 1] !== p - 1 && <span className="px-1 text-ink-3">…</span>}
                <a
                  href={buildHref({ page: p })}
                  className={`border px-3 py-1 ${
                    p === page ? "border-accent bg-accent text-white" : "border-line text-ink-2 hover:bg-surface-2"
                  }`}
                >
                  {p}
                </a>
              </span>
            ))}
          <a
            href={buildHref({ page: Math.min(totalPages, page + 1) })}
            aria-disabled={page >= totalPages}
            className={`border border-line px-3 py-1 ${page >= totalPages ? "pointer-events-none opacity-40" : "text-ink-2 hover:bg-surface-2"}`}
          >
            Next →
          </a>
        </div>
      )}
    </>
  );
}

export default async function ReplenishmentPage({
  searchParams,
}: {
  searchParams: ReplenishmentSearchParams;
}) {
  await requirePageAccess("replenishment");
  const supabase = await createClient();

  return (
    <main className="py-6">
      <h1 className="font-serif text-2xl">Replenishment</h1>
      <p className="mt-1 max-w-3xl text-[12.5px] text-ink-3">
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
    </main>
  );
}
