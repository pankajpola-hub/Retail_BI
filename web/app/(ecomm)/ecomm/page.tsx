import Link from "next/link";
import { createClient } from "@/lib/data/client";
import type { QueryChain } from "@/lib/data/client";
import { requirePageAccess } from "@/lib/auth/roles";
import { KpiCard } from "@/components/ui/KpiCard";
import { DateRangePicker } from "@/components/ui/DateRangePicker";
import { TrendChart } from "@/components/ui/TrendChart";

export const dynamic = "force-dynamic";

// Row shape from sales.vw_ecomm_daily (0067) — only the fields this page reads.
type DailyRow = {
  channel: string;
  order_date: string;
  total_orders: number;
  cancelled_orders: number;
  enriched_orders: number;
  units: number;
  net_selling_value: number | string;
  gross_mrp_value: number | string;
  discount_value: number | string;
  discount_pct: number | string | null;
  revenue_incomplete: boolean;
};

// Row shape from sales.vw_ecomm_order_lines (0067) — line grain, only orders
// past Uniware item-enrichment appear here at all (see that view's comment).
// That's exactly why the SKU table below needs its own "partial" messaging,
// independent of revenue_incomplete on the daily rows: a style with zero
// rows here in a recent window might just not be enriched yet, not zero sales.
type LineRow = {
  channel: string;
  order_date: string;
  status: string;
  item_sku: string;
  style: string | null;
  selling_price: number | string;
  mrp: number | string;
  discount: number | string;
};

// Row shape from sales.vw_ecomm_returns (0070) — only the fields this page
// reads. status/created_on/updated_on carry 0069's UNVERIFIED-field-name
// caveat (see that migration's header) — this page tallies whatever values
// actually show up rather than assuming a known workflow.
type ReturnRow = {
  reverse_pickup_code: string;
  sale_order_code: string;
  display_order_code: string | null;
  channel: string | null;
  return_awb: string | null;
  status: string | null;
  created_on: string;
  return_date: string;
  updated_on: string | null;
};

const INR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const num = (v: number | string) => (typeof v === "string" ? Number(v) : v);

export default async function EcommPage({
  searchParams,
}: {
  searchParams: { from?: string; to?: string; channel?: string };
}) {
  // requirePageAccess (not just (ecomm)/layout.tsx's requireRole) — same
  // split as every other page here: the layout's role check is coarse, this
  // is where the business_unit check (PAGE_BUSINESS_UNIT.ecomm = "ecomm")
  // actually runs, on top of any future per-user page override.
  await requirePageAccess("ecomm");

  const supabase = await createClient();

  const today = new Date();
  const defaultFrom = new Date(today);
  defaultFrom.setDate(defaultFrom.getDate() - 29);
  const from = searchParams.from ?? isoDate(defaultFrom);
  const to = searchParams.to ?? isoDate(today);
  // Per-channel drill-down (task 3) — URL state, not client-side-only, same
  // "filters are searchParams" convention as DateRangePicker/MultiSelectFilter
  // elsewhere in this app, so the page stays server-rendered. Narrowing only:
  // vw_ecomm_daily/vw_ecomm_order_lines already scope to the caller's granted
  // business_unit, so picking a channel here can never widen what's visible.
  const channel = searchParams.channel || null;

  const { data: rows, error } = await (supabase
    .schema("sales")
    .from<DailyRow>("vw_ecomm_daily")
    .select("*")
    .gte("order_date", from)
    .lte("order_date", to) as unknown as QueryChain<DailyRow>);

  if (error) {
    return (
      <main className="py-6">
        <h1 className="font-serif text-2xl">Ecomm</h1>
        <p className="mt-4 text-crit">Couldn&apos;t load Ecomm data: {error.message}</p>
      </main>
    );
  }

  const daily = rows ?? [];

  // Lines query for the SKU/style breakdown — same date range, plus the
  // channel filter when one is selected (DB-level, not JS-level: the whole
  // point of the drill-down is to avoid pulling every channel's line items
  // just to throw most of them away). This view only contains ORDERS PAST
  // ENRICHMENT (0067's header) — see revenue_incomplete usage below for why
  // that matters for this table specifically.
  let linesQuery = supabase
    .schema("sales")
    .from<LineRow>("vw_ecomm_order_lines")
    .select("channel, order_date, status, item_sku, style, selling_price, mrp, discount")
    .gte("order_date", from)
    .lte("order_date", to) as unknown as QueryChain<LineRow>;
  if (channel) linesQuery = linesQuery.eq("channel", channel);
  const { data: lineRows, error: linesError } = await linesQuery;
  const lines = lineRows ?? [];

  // Returns overview (Track A2) — filtered on return_date (created_on's date
  // cast), same "date this happened" semantics as order_date above, not
  // updated_on which would instead track when Uniware last touched the row.
  const { data: returnRows, error: returnsError } = await (supabase
    .schema("sales")
    .from<ReturnRow>("vw_ecomm_returns")
    .select("*")
    .gte("return_date", from)
    .lte("return_date", to) as unknown as QueryChain<ReturnRow>);
  const returns = returnRows ?? [];

  // Tally whatever status values actually appear — raw_uniware.returns.status
  // (0069) is an unverified field-name guess, so this deliberately doesn't
  // assume a fixed set of workflow stages.
  const byReturnStatus = new Map<string, number>();
  for (const r of returns) {
    const key = r.status ?? "(no status)";
    byReturnStatus.set(key, (byReturnStatus.get(key) ?? 0) + 1);
  }
  const returnStatusRows = [...byReturnStatus.entries()].sort((a, b) => b[1] - a[1]);
  const totalReturns = returns.length;

  // Rows scoped to the selected channel (or every channel when none is
  // selected) — feeds the trend chart and the "incomplete" flag for the SKU
  // table. The by-channel table below deliberately keeps using the
  // unfiltered `daily` so a channel row is always clickable to switch/clear,
  // not just to narrow further.
  const scopedDaily = channel ? daily.filter((r) => r.channel === channel) : daily;
  const scopedIncomplete = scopedDaily.some((r) => r.revenue_incomplete);

  function channelHref(target: string | null) {
    const params = new URLSearchParams({ from, to });
    if (target) params.set("channel", target);
    return `/ecomm?${params.toString()}`;
  }

  // --- Headline totals across every channel in range ---
  const totalOrders = daily.reduce((s, r) => s + r.total_orders, 0);
  const cancelledOrders = daily.reduce((s, r) => s + r.cancelled_orders, 0);
  const units = daily.reduce((s, r) => s + r.units, 0);
  const netSellingValue = daily.reduce((s, r) => s + num(r.net_selling_value), 0);
  const grossMrpValue = daily.reduce((s, r) => s + num(r.gross_mrp_value), 0);
  const discountValue = daily.reduce((s, r) => s + num(r.discount_value), 0);
  const discountPct = grossMrpValue > 0 ? (100 * discountValue) / grossMrpValue : null;
  const anyIncomplete = daily.some((r) => r.revenue_incomplete);
  const returnsPctOfOrders = totalOrders > 0 ? (100 * totalReturns) / totalOrders : null;

  // --- Daily trend (task 1) — net selling value per day, scoped to the
  // selected channel or summed network-wide when none is selected. Built
  // from `scopedDaily`, which is already one row per channel per day, so a
  // network-wide point is just a same-day sum across channels. ---
  const trendByDate = new Map<string, number>();
  for (const r of scopedDaily) {
    trendByDate.set(r.order_date, (trendByDate.get(r.order_date) ?? 0) + num(r.net_selling_value));
  }
  const trendPoints = [...trendByDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, value]) => ({ label: date, value }));

  // --- SKU/style breakdown (task 2) — vw_ecomm_order_lines is line grain,
  // grouped here by style (falling back to item_sku when style is blank —
  // real Uniware data occasionally omits item_name on a line). Same
  // "units = every line, net = lines excluding CANCELLED" convention as
  // vw_ecomm_daily's own lines_agg CTE (0067), so the totals here are
  // directly comparable to the daily/by-channel figures above rather than
  // quietly using a different definition of "units". ---
  const bySku = new Map<
    string,
    { key: string; units: number; net: number; mrp: number; discount: number }
  >();
  for (const l of lines) {
    const key = (l.style && l.style.trim()) || l.item_sku || "Unknown SKU";
    const s = bySku.get(key) ?? { key, units: 0, net: 0, mrp: 0, discount: 0 };
    s.units += 1;
    if (l.status !== "CANCELLED") s.net += num(l.selling_price);
    s.mrp += num(l.mrp);
    s.discount += num(l.discount);
    bySku.set(key, s);
  }
  const skuRows = [...bySku.values()].sort((a, b) => b.net - a.net);
  const SKU_LIMIT = 50;
  const topSkuRows = skuRows.slice(0, SKU_LIMIT);

  // Enrichment lag means this table is undercounted for any order not yet
  // synced (vw_ecomm_order_lines only has orders PAST enrichment at all) —
  // stronger than "the totals are a floor" on the daily view, it's "styles
  // from unenriched orders may be entirely missing from this list".
  const skuIncomplete = scopedIncomplete || linesError != null;

  // --- Channel breakdown — group the daily rows in JS, same pattern the
  // Network page uses to build its week tables from vw_ebo_sales_weekly
  // rows rather than a separate per-channel query. ---
  const byChannel = new Map<
    string,
    { orders: number; cancelled: number; units: number; net: number; mrp: number; discount: number; incomplete: boolean }
  >();
  for (const r of daily) {
    const c = byChannel.get(r.channel) ?? { orders: 0, cancelled: 0, units: 0, net: 0, mrp: 0, discount: 0, incomplete: false };
    c.orders += r.total_orders;
    c.cancelled += r.cancelled_orders;
    c.units += r.units;
    c.net += num(r.net_selling_value);
    c.mrp += num(r.gross_mrp_value);
    c.discount += num(r.discount_value);
    c.incomplete = c.incomplete || r.revenue_incomplete;
    byChannel.set(r.channel, c);
  }
  const channelRows = [...byChannel.entries()].sort((a, b) => b[1].net - a[1].net);

  return (
    <main className="py-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="font-serif text-2xl">Ecomm{channel ? ` — ${channel}` : ""}</h1>
          <p className="mt-1 text-[12.5px] text-ink-3">
            Marketplace &amp; D2C orders, synced from Uniware.
            {channel && (
              <>
                {" "}
                <Link href={channelHref(null)} className="text-accent underline">
                  Clear channel filter
                </Link>
              </>
            )}
          </p>
        </div>
        <DateRangePicker from={from} to={to} />
      </div>

      {anyIncomplete && (
        <p className="mt-3 border-l-2 border-warn bg-warn-soft px-3 py-2 text-sm text-ink-2">
          Some orders in this range haven&apos;t finished syncing line-item detail yet — revenue/discount
          figures below are a floor, not final, until enrichment catches up. Order counts are always
          complete.
        </p>
      )}

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <KpiCard label="Orders" value={String(totalOrders)} />
        <KpiCard label="Cancelled" value={String(cancelledOrders)} tone={cancelledOrders > 0 ? "muted" : "default"} />
        <KpiCard label="Units" value={String(units)} />
        <KpiCard label="Net selling value" value={INR(netSellingValue)} sub={anyIncomplete ? "partial" : undefined} />
        <KpiCard label="Discount" value={discountPct !== null ? `${discountPct.toFixed(1)}%` : "—"} sub={INR(discountValue) + " given"} />
        <KpiCard label="MRP value" value={INR(grossMrpValue)} />
      </div>

      <div className="mt-8">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">By channel</span>
        <p className="mt-1 text-[11.5px] text-ink-3">Click a channel for its own daily trend and SKU breakdown.</p>
        <div className="mt-2 overflow-x-auto border border-line-soft">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line-soft bg-surface-2 text-left text-[10px] uppercase tracking-wide text-ink-3">
                <th className="px-3 py-2">Channel</th>
                <th className="px-3 py-2 text-right">Orders</th>
                <th className="px-3 py-2 text-right">Cancelled</th>
                <th className="px-3 py-2 text-right">Units</th>
                <th className="px-3 py-2 text-right">Net value</th>
                <th className="px-3 py-2 text-right">Discount %</th>
              </tr>
            </thead>
            <tbody>
              {channelRows.map(([ch, c]) => (
                <tr
                  key={ch}
                  className={`border-b border-line-soft last:border-0 ${
                    channel === ch ? "bg-accent-soft" : ""
                  }`}
                >
                  <td className="px-3 py-2">
                    <Link
                      href={channelHref(channel === ch ? null : ch)}
                      className={`hover:underline ${channel === ch ? "font-semibold text-accent-ink" : ""}`}
                    >
                      {ch}
                    </Link>
                    {c.incomplete && (
                      <span className="ml-2 rounded-full border border-warn bg-warn-soft px-1.5 py-0.5 text-[10px] text-ink-2">
                        partial
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{c.orders}</td>
                  <td className="px-3 py-2 text-right font-mono">{c.cancelled}</td>
                  <td className="px-3 py-2 text-right font-mono">{c.units}</td>
                  <td className="px-3 py-2 text-right font-mono">{INR(c.net)}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {c.mrp > 0 ? `${((100 * c.discount) / c.mrp).toFixed(1)}%` : "—"}
                  </td>
                </tr>
              ))}
              {channelRows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-4 text-center text-sm text-ink-3">
                    No Ecomm orders in this range.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-8">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
          Net selling value by day{channel ? ` — ${channel}` : " — network-wide"}
        </span>
        <div className="mt-2 border border-line-soft p-3">
          {trendPoints.length > 0 ? (
            <TrendChart
              points={trendPoints}
              ariaLabel={`Daily net selling value${channel ? ` for ${channel}` : " across the network"}`}
            />
          ) : (
            <p className="py-10 text-center text-sm text-ink-3">No sales data in this window.</p>
          )}
        </div>
      </div>

      <div className="mt-8">
        <div className="flex items-baseline justify-between">
          <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
            Top styles{channel ? ` — ${channel}` : ""}
          </span>
          {skuRows.length > SKU_LIMIT && (
            <span className="text-[11px] text-ink-3">
              showing top {SKU_LIMIT} of {skuRows.length} styles by net revenue
            </span>
          )}
        </div>

        {skuIncomplete && (
          <p className="mt-2 border-l-2 border-warn bg-warn-soft px-3 py-2 text-sm text-ink-2">
            {linesError
              ? `Couldn't load line-item detail: ${linesError.message}`
              : "This breakdown only includes order lines that have finished Uniware item-enrichment — recent orders that haven't synced yet aren't just understated here, they can be entirely missing from the list below. Order-level counts and totals above are unaffected."}
          </p>
        )}

        <div className="mt-2 overflow-x-auto border border-line-soft">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line-soft bg-surface-2 text-left text-[10px] uppercase tracking-wide text-ink-3">
                <th className="px-3 py-2">Style</th>
                <th className="px-3 py-2 text-right">Units</th>
                <th className="px-3 py-2 text-right">Net revenue</th>
                <th className="px-3 py-2 text-right">Avg discount %</th>
              </tr>
            </thead>
            <tbody>
              {topSkuRows.map((s) => (
                <tr key={s.key} className="border-b border-line-soft last:border-0">
                  <td className="px-3 py-2">{s.key}</td>
                  <td className="px-3 py-2 text-right font-mono">{s.units}</td>
                  <td className="px-3 py-2 text-right font-mono">{INR(s.net)}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {s.mrp > 0 ? `${((100 * s.discount) / s.mrp).toFixed(1)}%` : "—"}
                  </td>
                </tr>
              ))}
              {topSkuRows.length === 0 && !linesError && (
                <tr>
                  <td colSpan={4} className="px-3 py-4 text-center text-sm text-ink-3">
                    No enriched order lines in this range{channel ? ` for ${channel}` : ""}.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-8">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Returns overview</span>
        <p className="mt-1 text-[11.5px] text-ink-3">
          Return status values are as reported by Uniware and haven&apos;t been mapped to a confirmed workflow
          yet — shown as-is.
        </p>

        {returnsError && (
          <p className="mt-2 border-l-2 border-crit bg-crit-soft px-3 py-2 text-sm text-ink-2">
            Couldn&apos;t load returns data: {returnsError.message}
          </p>
        )}

        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <KpiCard label="Returns" value={String(totalReturns)} />
          <KpiCard
            label="Returns % of orders"
            value={returnsPctOfOrders !== null ? `${returnsPctOfOrders.toFixed(1)}%` : "—"}
          />
        </div>

        <div className="mt-3 overflow-x-auto border border-line-soft">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line-soft bg-surface-2 text-left text-[10px] uppercase tracking-wide text-ink-3">
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Returns</th>
              </tr>
            </thead>
            <tbody>
              {returnStatusRows.map(([status, count]) => (
                <tr key={status} className="border-b border-line-soft last:border-0">
                  <td className="px-3 py-2">{status}</td>
                  <td className="px-3 py-2 text-right font-mono">{count}</td>
                </tr>
              ))}
              {returnStatusRows.length === 0 && !returnsError && (
                <tr>
                  <td colSpan={2} className="px-3 py-4 text-center text-sm text-ink-3">
                    No returns in this range.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
