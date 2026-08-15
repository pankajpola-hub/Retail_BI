import { createClient } from "@/lib/data/client";
import { requirePageAccess } from "@/lib/auth/roles";
import { RowsPerPageSelect } from "@/components/ui/RowsPerPageSelect";
import { computeSaleStockMix, MIX_STATUS_META, type MixStatus, type SalesPeriodDays } from "@/lib/replenishment/mix";

export const dynamic = "force-dynamic";

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-IN");
}
function pct(n: number): string {
  return `${n.toFixed(1)}%`;
}
function pts(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}pp`;
}

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

export default async function SaleStockMixPage({
  searchParams,
}: {
  searchParams: {
    store?: string;
    style?: string;
    color?: string;
    period?: string;
    status?: string;
    page?: string;
    perPage?: string;
  };
}) {
  await requirePageAccess("replenishment");
  const supabase = await createClient();

  const storeId = searchParams.store ?? "";
  const periodParam = Number(searchParams.period) as SalesPeriodDays;
  const salesPeriodDays: SalesPeriodDays = PERIOD_OPTIONS.includes(periodParam) ? periodParam : 30;

  const { storeList, rows, totalSales, totalStock } = await computeSaleStockMix(supabase, { storeId, salesPeriodDays });

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
    <main className="py-6">
      <h1 className="font-serif text-2xl">Sale Mix vs Stock Mix</h1>
      <p className="mt-1 max-w-3xl text-[12.5px] text-ink-3">
        By <strong>Style No. + Color</strong>: what share of recent sales does this style-color earn, versus what
        share of current stock it&apos;s holding? A style-color selling faster than its stock share suggests
        allocation is warranted; one holding more stock than it sells suggests the opposite. This is one input into
        the Replenishment page&apos;s allocation recommendations — the two are meant to be read together, not as
        competing answers.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-px border border-line-soft bg-line-soft sm:grid-cols-3 lg:grid-cols-5">
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
        <label className="flex flex-col gap-1">
          Store
          <select name="store" defaultValue={storeId} className="min-h-[34px] border border-line bg-surface px-2 py-1.5">
            <option value="">All stores</option>
            {storeList.map((s) => (
              <option key={s.store_id} value={s.store_id}>
                {s.store_name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Style No.
          <input
            type="text"
            name="style"
            defaultValue={searchParams.style ?? ""}
            placeholder="style no."
            className="min-h-[34px] w-40 border border-line bg-surface px-2 py-1.5"
          />
        </label>
        <label className="flex flex-col gap-1">
          Color
          <input
            type="text"
            name="color"
            defaultValue={searchParams.color ?? ""}
            placeholder="color"
            className="min-h-[34px] w-40 border border-line bg-surface px-2 py-1.5"
          />
        </label>
        <label className="flex flex-col gap-1">
          Sales period
          <select name="period" defaultValue={String(salesPeriodDays)} className="min-h-[34px] border border-line bg-surface px-2 py-1.5">
            {PERIOD_OPTIONS.map((p) => (
              <option key={p} value={p}>
                Last {p} days
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Status
          <select name="status" defaultValue={statusFilter} className="min-h-[34px] border border-line bg-surface px-2 py-1.5">
            <option value="">All</option>
            {(Object.keys(MIX_STATUS_META) as MixStatus[]).map((s) => (
              <option key={s} value={s}>
                {MIX_STATUS_META[s].label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="min-h-[34px] border border-line px-4 py-1.5 text-[13px] text-ink-2">
          Apply
        </button>
      </form>

      {/* --- Table --- */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <span className="text-[12px] text-ink-3">
          {totalRows === 0 ? "0 rows" : `Showing ${fmt(pageStart + 1)}–${fmt(Math.min(pageStart + perPageNum, totalRows))} of ${fmt(totalRows)} rows`}
        </span>
        <RowsPerPageSelect selected={perPageParam} />
      </div>
      <div className="mt-2 overflow-x-auto border border-line-soft">
        <table className="w-full min-w-[1000px] text-[12.5px]">
          <thead>
            <tr className="border-b border-line-soft bg-surface-2 text-left text-[10px] uppercase tracking-wide text-ink-3">
              <th className="px-2 py-2">Style No.</th>
              <th className="px-2 py-2">Color</th>
              <th className="px-2 py-2 text-right">Sales</th>
              <th className="px-2 py-2 text-right">Sale Mix</th>
              <th className="px-2 py-2 text-right">SOH</th>
              <th className="px-2 py-2 text-right">Stock Mix</th>
              <th className="px-2 py-2 text-right">Mix Gap</th>
              <th className="px-2 py-2">Status</th>
              <th className="px-2 py-2">Action</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-2 py-4 text-center text-ink-3">
                  No style-colors match these filters.
                </td>
              </tr>
            ) : (
              pageRows.map((r) => {
                const meta = MIX_STATUS_META[r.status];
                const isAllocationCandidate = r.status === "high_priority" || r.status === "opportunity";
                const warehouseBlocked = isAllocationCandidate && r.warehouseAvailable === 0;
                return (
                  <tr key={`${r.styleNo}-${r.color}`} className="border-b border-line-soft align-top last:border-0">
                    <td className="px-2 py-2 font-mono text-[11.5px]">
                      {r.styleNo}
                      {r.negativeStock && <span className="ml-1 text-crit" title="Negative stock in source data">⚠</span>}
                    </td>
                    <td className="px-2 py-2 text-ink-2">{r.color}</td>
                    <td className="px-2 py-2 text-right font-mono">{fmt(r.sales)}</td>
                    <td className="px-2 py-2 text-right font-mono">{pct(r.saleMixPct)}</td>
                    <td className="px-2 py-2 text-right font-mono">{fmt(r.soh)}</td>
                    <td className="px-2 py-2 text-right font-mono">{pct(r.stockMixPct)}</td>
                    <td
                      className={`px-2 py-2 text-right font-mono font-semibold ${
                        r.mixGapPts > 0 ? "text-good" : r.mixGapPts < 0 ? "text-crit" : "text-ink-3"
                      }`}
                    >
                      {pts(r.mixGapPts)}
                    </td>
                    <td className={`px-2 py-2 ${meta.className}`}>
                      {meta.dot} {meta.demandLabel}
                    </td>
                    <td className="px-2 py-2 text-ink-2">
                      {warehouseBlocked ? (
                        <span className="text-warn">Demand Opportunity — Warehouse Stock Unavailable</span>
                      ) : (
                        meta.action
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

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
    </main>
  );
}
