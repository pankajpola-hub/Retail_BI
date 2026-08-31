/**
 * Pure aggregation for /sale-summary — wholesale/distribution-channel sales
 * (raw_logic.channel_sales_summary via sales.vw_channel_sales_summary,
 * migration 0101). Mirrors this app's established convention (see
 * lib/sales/aggregate.ts's computeSalesTotals/computeLeague): every ratio
 * (discount/markup %) is recomputed from SUMMED numerator/denominator, never
 * averaged from per-row or per-group percentages — averaging would weight a
 * ₹500 row the same as a ₹50 lakh row.
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
  /**
   * Signed: (Σgross - Σnet) / Σgross * 100. Positive means a real discount
   * (net < gross, the everyday case). Negative means net EXCEEDS gross for
   * this scope — a genuine, confirmed convention for this channel (markup /
   * GST-inclusive net — see migration 0101's header), not a data error.
   */
  discountPct: number | null;
  /** True when discountPct < 0 — the KPI card flips the sign and relabels "Markup %" rather than showing a confusing negative discount. */
  isMarkup: boolean;
  /** Σnet_amount over rows with total_quantity < 0 (returns). Can itself be positive or negative depending on this channel's net/gross convention on returned lines. */
  returnsValue: number;
  /** Distinct channel_name in the current (already filtered) scope. */
  activeChannels: number;
  /** MoM: last two distinct bill_month values present in scope, Σnet each, (latest-prior)/|prior|*100. null if fewer than 2 months are in scope. */
  momPct: number | null;
  latestMonth: string | null;
  priorMonth: string | null;
};

export function computeChannelSalesKpis(rows: ChannelSalesRow[]): ChannelSalesKpis {
  let totalNet = 0;
  let totalGross = 0;
  let totalQty = 0;
  let returnsValue = 0;
  const channels = new Set<string>();
  const byMonth = new Map<string, number>();

  for (const r of rows) {
    const net = num(r.net_amount);
    const gross = num(r.gross_amount);
    const qty = num(r.total_quantity);
    totalNet += net;
    totalGross += gross;
    totalQty += qty;
    if (qty < 0) returnsValue += net;
    if (r.channel_name) channels.add(r.channel_name);
    byMonth.set(r.bill_month, (byMonth.get(r.bill_month) ?? 0) + net);
  }

  const discountPct = totalGross !== 0 ? ((totalGross - totalNet) / totalGross) * 100 : null;
  const isMarkup = discountPct !== null && discountPct < 0;

  const months = [...byMonth.keys()].sort();
  const lastTwo = months.slice(-2);
  let momPct: number | null = null;
  if (lastTwo.length === 2) {
    const [prior, latest] = lastTwo as [string, string];
    const priorVal = byMonth.get(prior) ?? 0;
    const latestVal = byMonth.get(latest) ?? 0;
    momPct = priorVal !== 0 ? ((latestVal - priorVal) / Math.abs(priorVal)) * 100 : null;
  }

  return {
    totalNet,
    totalGross,
    totalQty,
    discountPct,
    isMarkup,
    returnsValue,
    activeChannels: channels.size,
    momPct,
    latestMonth: lastTwo[1] ?? null,
    priorMonth: lastTwo[0] ?? null,
  };
}

export type BreakdownRow = {
  key: string;
  qty: number;
  gross: number;
  net: number;
  discountPct: number | null;
};

/** Groups rows by `keyOf`, summing qty/gross/net and recomputing discountPct from the summed parts — the table-footer-subtotal pattern PeriodSalesFacetedTable/AgentSalesFacetedTable/StoreDiagnosisFacetedTable already establish. */
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
  return [...map.entries()]
    .map(([key, v]) => ({
      key,
      ...v,
      discountPct: v.gross !== 0 ? ((v.gross - v.net) / v.gross) * 100 : null,
    }))
    .sort((a, b) => b.net - a.net);
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
