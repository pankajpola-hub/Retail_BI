import { createClient } from "@/lib/data/client";
import type { QueryChain } from "@/lib/data/client";
import { requirePageAccess } from "@/lib/auth/roles";
import { KpiCard } from "@/components/ui/KpiCard";
import { DateRangePicker } from "@/components/ui/DateRangePicker";

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

const INR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const num = (v: number | string) => (typeof v === "string" ? Number(v) : v);

export default async function EcommPage({
  searchParams,
}: {
  searchParams: { from?: string; to?: string };
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

  // --- Headline totals across every channel in range ---
  const totalOrders = daily.reduce((s, r) => s + r.total_orders, 0);
  const cancelledOrders = daily.reduce((s, r) => s + r.cancelled_orders, 0);
  const units = daily.reduce((s, r) => s + r.units, 0);
  const netSellingValue = daily.reduce((s, r) => s + num(r.net_selling_value), 0);
  const grossMrpValue = daily.reduce((s, r) => s + num(r.gross_mrp_value), 0);
  const discountValue = daily.reduce((s, r) => s + num(r.discount_value), 0);
  const discountPct = grossMrpValue > 0 ? (100 * discountValue) / grossMrpValue : null;
  const anyIncomplete = daily.some((r) => r.revenue_incomplete);

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
          <h1 className="font-serif text-2xl">Ecomm</h1>
          <p className="mt-1 text-[12.5px] text-ink-3">Marketplace &amp; D2C orders, synced from Uniware.</p>
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
              {channelRows.map(([channel, c]) => (
                <tr key={channel} className="border-b border-line-soft last:border-0">
                  <td className="px-3 py-2">
                    {channel}
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
    </main>
  );
}
