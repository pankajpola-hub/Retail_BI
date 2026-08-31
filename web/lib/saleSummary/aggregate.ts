/**
 * Pure aggregation for /sale-summary — wholesale/distribution-channel sales
 * (raw_logic.channel_sales_summary via sales.vw_channel_sales_summary,
 * migration 0101). Mirrors this app's established convention (see
 * lib/sales/aggregate.ts's computeSalesTotals/computeLeague): every ratio is
 * recomputed from SUMMED numerator/denominator, never averaged from per-row
 * or per-group percentages — averaging would weight a ₹500 row the same as a
 * ₹50 lakh row.
 *
 * DISCOUNT/MARKUP % REMOVED (2026-08-31, per Pankaj): gross_amount is the
 * TAXABLE value and net_amount is the AFTER-TAX value for this channel — the
 * (gross-net)/gross figure this page used to show as "Discount %"/"Markup %"
 * was therefore a tax-rate artifact, not a real discount/markup, and worse,
 * whether to check discount against MRP*qty, taxable value, or net value
 * differs PARTY-BY-PARTY (this data has no MRP column to even attempt that
 * check). Hidden everywhere on this page until a proper discount engine
 * (one that knows each party's actual basis) replaces it — do not
 * reintroduce (gross-net)/gross as "discount" anywhere on this page.
 */

export type ChannelSalesRow = {
  id: number;
  branch_name: string;
  bill_month: string; // 'YYYY-MM-DD', always the 1st of the month
  party_name: string;
  channel_name: string;
  channel_type: string | null;
  channel_model: string | null;
  total_quantity: number | string;
  gross_amount: number | string;
  net_amount: number | string;
};

export const num = (v: number | string) => (typeof v === "string" ? Number(v) : v);

export type ChannelSalesKpis = {
  totalNet: number;
  totalGross: number;
  totalQty: number;
  /** Σnet_amount over rows with total_quantity < 0 (returns). Can itself be positive or negative depending on this channel's net/gross convention on returned lines. */
  returnsValue: number;
  /** Distinct channel_name in the current (already filtered) scope. */
  activeChannels: number;
};

/**
 * The naive "last two months in scope" MoM growth this used to compute is
 * gone — see lib/saleSummary/comparison.ts for its MoM/YoY/like-to-like
 * replacement, which (unlike this function) needs data outside `rows` alone
 * (a lookback row set for the comparison month) so it isn't a pure function
 * of one row array the way every other KPI here is.
 */
export function computeChannelSalesKpis(rows: ChannelSalesRow[]): ChannelSalesKpis {
  let totalNet = 0;
  let totalGross = 0;
  let totalQty = 0;
  let returnsValue = 0;
  const channels = new Set<string>();

  for (const r of rows) {
    const net = num(r.net_amount);
    const gross = num(r.gross_amount);
    const qty = num(r.total_quantity);
    totalNet += net;
    totalGross += gross;
    totalQty += qty;
    if (qty < 0) returnsValue += net;
    if (r.channel_name) channels.add(r.channel_name);
  }

  return {
    totalNet,
    totalGross,
    totalQty,
    returnsValue,
    activeChannels: channels.size,
  };
}

export type BreakdownRow = {
  key: string;
  qty: number;
  gross: number;
  net: number;
};

/** Groups rows by `keyOf`, summing qty/gross/net — the table-footer-subtotal pattern PeriodSalesFacetedTable/AgentSalesFacetedTable/StoreDiagnosisFacetedTable already establish. */
export function computeBreakdown(rows: ChannelSalesRow[], keyOf: (r: ChannelSalesRow) => string): BreakdownRow[] {
  const map = new Map<string, { qty: number; gross: number; net: number }>();
  for (const r of rows) {
    const key = keyOf(r) || "(blank)";
    const cur = map.get(key) ?? { qty: 0, gross: 0, net: 0 };
    cur.qty += num(r.total_quantity);
    cur.gross += num(r.gross_amount);
    cur.net += num(r.net_amount);
    map.set(key, cur);
  }
  return [...map.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.net - a.net);
}

export type TrendPoint = { label: string; value: number; date: string };

/** One point per distinct bill_month, Σnet_amount — feeds TrendChart. */
export function computeMonthlyTrend(rows: ChannelSalesRow[]): TrendPoint[] {
  const byMonth = new Map<string, number>();
  for (const r of rows) byMonth.set(r.bill_month, (byMonth.get(r.bill_month) ?? 0) + num(r.net_amount));
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, value]) => ({ label: month.slice(0, 7), value, date: month }));
}
