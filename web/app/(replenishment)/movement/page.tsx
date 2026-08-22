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
import { computeSaleStockMix, MIX_STATUS_META, type MixStatus, type SalesPeriodDays } from "@/lib/replenishment/mix";
import { ReplenishmentGrid } from "../replenishment/ReplenishmentGrid";
import { SaleStockMixGrid } from "../sale-stock-mix/SaleStockMixGrid";

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

  const { storeList, rows, totalWarehouseUnits } = await time(
    "replenishment:compute",
    computeReplenishmentRows(supabase, {
      targetCoverDays,
      leadTimeDays,
      safetyDays,
      scoreWeights: SCORE_W,
    })
  );

  const q = searchParams.q ?? "";
  const storeFilter = searchParams.store ?? "";
  const priorityFilter = searchParams.priority ?? "";
  const actionFilter = searchParams.action ?? "";

  const filtered = filterRows(rows, { q, store: storeFilter, priority: priorityFilter, action: actionFilter });
  filtered.sort((a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority) || b.score - a.score);

  const PER_PAGE_OPTIONS = ["10", "50", "100", "max"];
  const perPageParam = PER_PAGE_OPTIONS.includes(searchParams.perPage ?? "") ? (searchParams.perPage as string) : "50";
  const totalRows = filtered.length;
  const perPageNum = perPageParam === "max" ? Math.max(1, totalRows) : Number(perPageParam);
  const totalPages = Math.max(1, Math.ceil(totalRows / perPageNum));
  const page = Math.min(totalPages, Math.max(1, Number(searchParams.page) || 1));
  const pageStart = (page - 1) * perPageNum;
  const pageRows = filtered.slice(pageStart, pageStart + perPageNum);

  // Preserves the mix_-prefixed params too (untouched), same "don't lose
  // the other tab's state" principle as tabHref.
  function buildHref(overrides: Record<string, string | number>): string {
    const params = new URLSearchParams();
    const current: Record<string, string | undefined> = {
      tab: "replenishment",
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

  const downloadHref = (() => {
    const params = new URLSearchParams(buildHref({}).slice(1));
    params.delete("page");
    params.delete("perPage");
    params.delete("tab");
    // downloadHref carries mix_-prefixed params too since buildHref
    // preserves them — harmless (the download route only reads the names
    // it knows), but strip them for a tidier query string.
    params.delete("mix_store");
    params.delete("mix_style");
    params.delete("mix_color");
    params.delete("mix_period");
    params.delete("mix_status");
    params.delete("mix_page");
    params.delete("mix_perPage");
    const qs = params.toString();
    return `/api/replenishment/download${qs ? `?${qs}` : ""}`;
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

      <details className="mt-4 border border-line-soft p-4">
        <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-ink-2">
          Assumptions (what-if) — target cover {targetCoverDays}d · lead time {leadTimeDays}d · safety {safetyDays}d
        </summary>
        <form className="mt-3 flex flex-wrap items-end gap-4 text-[12.5px]">
          <input type="hidden" name="tab" value="replenishment" />
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

      <form className="mt-4 flex flex-wrap items-end gap-3 text-[12.5px]">
        <input type="hidden" name="tab" value="replenishment" />
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
  const storeId = searchParams.mix_store ?? "";
  const periodParam = Number(searchParams.mix_period) as SalesPeriodDays;
  const salesPeriodDays: SalesPeriodDays = PERIOD_OPTIONS.includes(periodParam) ? periodParam : 30;

  const { storeList, rows, totalSales, totalStock } = await time(
    "sale-stock-mix:compute",
    computeSaleStockMix(supabase, { storeId, salesPeriodDays })
  );

  const styleQ = (searchParams.mix_style ?? "").trim().toLowerCase();
  const colorQ = (searchParams.mix_color ?? "").trim().toLowerCase();
  const statusFilter = (searchParams.mix_status ?? "") as MixStatus | "";

  const filtered = rows.filter((r) => {
    if (styleQ && !r.styleNo.toLowerCase().includes(styleQ)) return false;
    if (colorQ && !r.color.toLowerCase().includes(colorQ)) return false;
    if (statusFilter && r.status !== statusFilter) return false;
    return true;
  });

  const counts: Record<MixStatus, number> = {
    high_priority: 0,
    opportunity: 0,
    balanced: 0,
    stock_heavy: 0,
    overstocked: 0,
  };
  for (const r of rows) counts[r.status]++;

  const PER_PAGE_OPTIONS = ["10", "50", "100", "max"];
  const perPageParam = PER_PAGE_OPTIONS.includes(searchParams.mix_perPage ?? "") ? (searchParams.mix_perPage as string) : "50";
  const totalRows = filtered.length;
  const perPageNum = perPageParam === "max" ? Math.max(1, totalRows) : Number(perPageParam);
  const totalPages = Math.max(1, Math.ceil(totalRows / perPageNum));
  const page = Math.min(totalPages, Math.max(1, Number(searchParams.mix_page) || 1));
  const pageStart = (page - 1) * perPageNum;
  const pageRows = filtered.slice(pageStart, pageStart + perPageNum);

  function buildHref(overrides: Record<string, string | number>): string {
    const params = new URLSearchParams();
    const current: Record<string, string | undefined> = {
      tab: "mix",
      // Preserve the Replenishment tab's own state too.
      q: searchParams.q,
      store: searchParams.store,
      priority: searchParams.priority,
      action: searchParams.action,
      targetCover: searchParams.targetCover,
      leadTime: searchParams.leadTime,
      safetyDays: searchParams.safetyDays,
      wStockout: searchParams.wStockout,
      wVelocity: searchParams.wVelocity,
      wCover: searchParams.wCover,
      wRevenue: searchParams.wRevenue,
      wTrend: searchParams.wTrend,
      wProductivity: searchParams.wProductivity,
      perPage: searchParams.perPage,
      page: searchParams.page,
      mix_store: storeId || undefined,
      mix_style: searchParams.mix_style,
      mix_color: searchParams.mix_color,
      mix_period: String(salesPeriodDays),
      mix_status: statusFilter || undefined,
      mix_perPage: perPageParam,
      mix_page: String(page),
    };
    for (const [k, v] of Object.entries(current)) if (v) params.set(k, v);
    for (const [k, v] of Object.entries(overrides)) params.set(k, String(v));
    return `?${params.toString()}`;
  }

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
        <input type="hidden" name="mix_perPage" value={perPageParam} />
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
          Style No.
          <Input type="text" name="mix_style" defaultValue={searchParams.mix_style ?? ""} placeholder="style no." className="w-40" />
        </Label>
        <Label className="flex flex-col gap-1">
          Color
          <Input type="text" name="mix_color" defaultValue={searchParams.mix_color ?? ""} placeholder="color" className="w-40" />
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
        <Label className="flex flex-col gap-1">
          Status
          <Select name="mix_status" defaultValue={statusFilter}>
            <option value="">All</option>
            {(Object.keys(MIX_STATUS_META) as MixStatus[]).map((s) => (
              <option key={s} value={s}>
                {MIX_STATUS_META[s].label}
              </option>
            ))}
          </Select>
        </Label>
        <Button type="submit" variant="outline">Apply</Button>
      </form>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <span className="text-[12px] text-ink-3">
          {totalRows === 0 ? "0 rows" : `Showing ${fmt(pageStart + 1)}–${fmt(Math.min(pageStart + perPageNum, totalRows))} of ${fmt(totalRows)} rows`}
        </span>
        <RowsPerPageSelect selected={perPageParam} paramName="mix_perPage" pageParamName="mix_page" />
      </div>
      <SaleStockMixGrid rows={pageRows} />

      {totalPages > 1 && (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-1 text-[12.5px]">
          <a
            href={buildHref({ mix_page: Math.max(1, page - 1) })}
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
                  href={buildHref({ mix_page: p })}
                  className={`border px-3 py-1 ${
                    p === page ? "border-accent bg-accent text-white" : "border-line text-ink-2 hover:bg-surface-2"
                  }`}
                >
                  {p}
                </a>
              </span>
            ))}
          <a
            href={buildHref({ mix_page: Math.min(totalPages, page + 1) })}
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

export default async function MovementPage({
  searchParams,
}: {
  searchParams: MovementSearchParams;
}) {
  await requirePageAccess("replenishment");
  const supabase = await createClient();
  const tab = searchParams.tab === "mix" ? "mix" : "replenishment";

  return (
    <main className="py-6">
      <h1 className="font-serif text-2xl">Movement</h1>
      <p className="mt-1 max-w-3xl text-[12.5px] text-ink-3">
        Replenishment recommendations and Sale vs Stock Mix — meant to be read together, not as competing answers.
      </p>

      <div className="mt-4 flex gap-1 border-b border-line-soft text-[13px]">
        <a
          href={tabHref(searchParams, "replenishment")}
          className={`border-b-2 px-3 py-2 ${
            tab === "replenishment" ? "border-accent font-semibold text-ink" : "border-transparent text-ink-3 hover:text-ink-2"
          }`}
        >
          Replenishment
        </a>
        <a
          href={tabHref(searchParams, "mix")}
          className={`border-b-2 px-3 py-2 ${
            tab === "mix" ? "border-accent font-semibold text-ink" : "border-transparent text-ink-3 hover:text-ink-2"
          }`}
        >
          Sale vs Stock Mix
        </a>
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
    </main>
  );
}
