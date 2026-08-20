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
import { computeSaleStockMix, MIX_STATUS_META, type MixStatus, type SalesPeriodDays } from "@/lib/replenishment/mix";
import { SaleStockMixGrid } from "./SaleStockMixGrid";

export const dynamic = "force-dynamic";

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-IN");
}
// pct/pts (percent / signed-points formatters) moved into
// SaleStockMixGrid.tsx (2026-08-20) — this page no longer renders the raw
// table cells that needed them.

function KpiCard({ label, value, tone }: { label: string; value: string; tone?: "warn" | "crit" | "good" }) {
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
    </div>
  );
}

const PERIOD_OPTIONS: SalesPeriodDays[] = [7, 30, 60, 90];

type MixSearchParams = {
  store?: string;
  style?: string;
  color?: string;
  period?: string;
  status?: string;
  page?: string;
  perPage?: string;
};

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
 * Same shape as ReplenishmentContent — one expensive computeSaleStockMix()
 * call feeds the KPIs, filter form (needs storeList) and the whole table, so
 * this is one Suspense boundary rather than several. The shell (title,
 * intro) above it renders instantly.
 */
async function SaleStockMixContent({
  supabase,
  searchParams,
}: {
  supabase: DataClient;
  searchParams: MixSearchParams;
}) {
  const storeId = searchParams.store ?? "";
  const periodParam = Number(searchParams.period) as SalesPeriodDays;
  const salesPeriodDays: SalesPeriodDays = PERIOD_OPTIONS.includes(periodParam) ? periodParam : 30;

  const { storeList, rows, totalSales, totalStock } = await time(
    "sale-stock-mix:compute",
    computeSaleStockMix(supabase, { storeId, salesPeriodDays })
  );

  const styleQ = (searchParams.style ?? "").trim().toLowerCase();
  const colorQ = (searchParams.color ?? "").trim().toLowerCase();
  const statusFilter = (searchParams.status ?? "") as MixStatus | "";

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

  // --- Pagination — same 10/50/100/max convention as the Replenishment page. ---
  const PER_PAGE_OPTIONS = ["10", "50", "100", "max"];
  const perPageParam = PER_PAGE_OPTIONS.includes(searchParams.perPage ?? "") ? (searchParams.perPage as string) : "50";
  const totalRows = filtered.length;
  const perPageNum = perPageParam === "max" ? Math.max(1, totalRows) : Number(perPageParam);
  const totalPages = Math.max(1, Math.ceil(totalRows / perPageNum));
  const page = Math.min(totalPages, Math.max(1, Number(searchParams.page) || 1));
  const pageStart = (page - 1) * perPageNum;
  const pageRows = filtered.slice(pageStart, pageStart + perPageNum);

  function buildHref(overrides: Record<string, string | number>): string {
    const params = new URLSearchParams();
    const current: Record<string, string | undefined> = {
      store: storeId || undefined,
      style: searchParams.style,
      color: searchParams.color,
      period: String(salesPeriodDays),
      status: statusFilter || undefined,
      perPage: perPageParam,
      page: String(page),
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

      {/* --- Filters --- */}
      <form className="mt-4 flex flex-wrap items-end gap-3 text-[12.5px]">
        <input type="hidden" name="perPage" value={perPageParam} />
        <Label className="flex flex-col gap-1">
          Store
          <Select name="store" defaultValue={storeId}>
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
          <Input type="text" name="style" defaultValue={searchParams.style ?? ""} placeholder="style no." className="w-40" />
        </Label>
        <Label className="flex flex-col gap-1">
          Color
          <Input type="text" name="color" defaultValue={searchParams.color ?? ""} placeholder="color" className="w-40" />
        </Label>
        <Label className="flex flex-col gap-1">
          Sales period
          <Select name="period" defaultValue={String(salesPeriodDays)}>
            {PERIOD_OPTIONS.map((p) => (
              <option key={p} value={p}>
                Last {p} days
              </option>
            ))}
          </Select>
        </Label>
        <Label className="flex flex-col gap-1">
          Status
          <Select name="status" defaultValue={statusFilter}>
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

      {/* --- Table --- */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <span className="text-[12px] text-ink-3">
          {totalRows === 0 ? "0 rows" : `Showing ${fmt(pageStart + 1)}–${fmt(Math.min(pageStart + perPageNum, totalRows))} of ${fmt(totalRows)} rows`}
        </span>
        <RowsPerPageSelect selected={perPageParam} />
      </div>
      <SaleStockMixGrid rows={pageRows} />

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

export default async function SaleStockMixPage({
  searchParams,
}: {
  searchParams: MixSearchParams;
}) {
  await requirePageAccess("replenishment");
  const supabase = await createClient();

  return (
    <main className="py-6">
      <h1 className="font-serif text-2xl">Sale Mix vs Stock Mix</h1>
      <p className="mt-1 max-w-3xl text-[12.5px] text-ink-3">
        By <strong>Style No. + Color</strong>: what share of recent sales does this style-color earn, versus what
        share of current stock it&apos;s holding? A style-color selling faster than its stock share suggests
        allocation is warranted; one holding more stock than it sells suggests the opposite. This is one input into
        the Replenishment page&apos;s allocation recommendations — the two are meant to be read together, not as
        competing answers.
      </p>

      <SectionErrorBoundary label="Sale Mix vs Stock Mix">
        <Suspense fallback={<SaleStockMixSkeleton />}>
          <SaleStockMixContent supabase={supabase} searchParams={searchParams} />
        </Suspense>
      </SectionErrorBoundary>
    </main>
  );
}
