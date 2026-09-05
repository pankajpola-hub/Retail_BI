/**
 * Line-level re-derivations of the EBO displays that used to read a
 * pre-aggregated rollup view.
 *
 * WHY THIS FILE EXISTS: the hourly chart read sales.vw_ebo_sales_hourly, the
 * store league read sales.vw_ebo_sales_weekly, scheme penetration read
 * sales.vw_ebo_scheme_daily and the agent table read
 * sales.vw_ebo_agent_daily. Not one of those rollups carries a product
 * attribute, so none of them can answer "…for DRESSES only". Every function
 * here recomputes the SAME figure from sales.vw_ebo_sale_attribute_lines
 * (0092 + 0103) instead, so the identical display can be narrowed by the
 * attribute filter.
 *
 * THE ARITHMETIC IS COPIED, NOT REINVENTED. Each function below reproduces the
 * exact grouping and filtering its source view used — verified by reading the
 * live view definitions, quoted per function. Where the app's own JS layer
 * added a further rule on top (computeLeague's ATV denominator,
 * computeHourlyPoints' 9am-11pm business-hours window, computeAgentRows'
 * branch-code stripping and top-12 cut), that rule is reproduced here too, so
 * a display's numbers do not shift merely because its source changed. The one
 * thing that legitimately changes a number is the attribute filter itself.
 *
 * SIGN CONVENTION: rows arrive already signed — a RETURN line's net_amount and
 * total_quantity are NEGATIVE (commit 014b1c5). Nothing here applies a sign
 * rule of its own; returns net themselves out of the all-bill-type sums
 * because the values are already negative. Same contract, and same warning
 * against "fixing" it, as lib/sales/attributeBreakdown.ts's header.
 *
 * RATIOS ARE ALWAYS Σnumerator / Σdenominator, never an average of per-row
 * ratios — the rule computeLeague and computeSalesTotals already follow.
 */

import type { SaleLineRow } from "./attributeFilter";
import { HOUR_START, HOUR_END } from "./aggregate";

const numOf = (v: number | string | null | undefined): number => {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : 0;
};

/**
 * Bill identity is (store, date, bill_no) — bill numbers restart each fiscal
 * year and are only unique within a branch, per the bill-number format, so
 * bill_no alone collides. Same key attributeBreakdown.ts builds.
 */
const billKeyOf = (l: SaleLineRow) => `${l.store_id ?? ""}|${l.bill_date ?? ""}|${l.bill_no ?? ""}`;

const isSale = (l: SaleLineRow) => l.bill_type === "SALE";

// ---------------------------------------------------------------------------
// Store league
// ---------------------------------------------------------------------------

export type LineLeagueRow = {
  storeId: string;
  name: string;
  net: number;
  gross: number;
  discount: number;
  bills: number;
  qty: number;
  atv: number | null;
  upt: number | null;
  discountPct: number | null;
};

/**
 * Reproduces computeLeague() over lines.
 *
 * sales.vw_ebo_sales_daily (which the weekly rollup computeLeague reads is
 * built from) sums net_sales / gross_sales / discount across ALL bill types,
 * and counts sale_bills / sale_quantity over SALE bills only. Both rules are
 * reproduced exactly.
 *
 * ATV/UPT deliberately use computeLeague's OWN denominators — all-bill-type
 * net over SALE bills — not vw_ebo_sales_daily's atv column, which divides
 * SALE-only net by sale bills. Those two genuinely differ on a store with
 * returns, and this function is replacing computeLeague, so it matches
 * computeLeague. Changing which of the two is "right" is a separate question
 * from moving the data source, and is not being smuggled in here.
 */
export function computeLeagueFromLines(lines: SaleLineRow[], storeNames: Map<string, string>): LineLeagueRow[] {
  const byStore = new Map<string, { net: number; gross: number; discount: number; qty: number; billKeys: Set<string> }>();

  for (const l of lines) {
    const sid = l.store_id;
    if (!sid) continue;
    let cur = byStore.get(sid);
    if (!cur) {
      cur = { net: 0, gross: 0, discount: 0, qty: 0, billKeys: new Set() };
      byStore.set(sid, cur);
    }
    const net = numOf(l.net_amount);
    const gross = numOf(l.gross_amount);
    cur.net += net;
    cur.gross += gross;
    // discount_amount is gross - net on the source line (vw_ebo_sales_lines
    // computes it that way); recomputed rather than carried so this view need
    // not expose a column that is a pure function of two it already has.
    cur.discount += gross - net;
    if (isSale(l)) {
      cur.qty += numOf(l.total_quantity);
      cur.billKeys.add(billKeyOf(l));
    }
  }

  return [...byStore.entries()]
    .map(([storeId, v]) => {
      const bills = v.billKeys.size;
      return {
        storeId,
        name: storeNames.get(storeId) ?? storeId,
        net: v.net,
        gross: v.gross,
        discount: v.discount,
        bills,
        qty: v.qty,
        atv: bills > 0 ? v.net / bills : null,
        upt: bills > 0 ? v.qty / bills : null,
        discountPct: v.gross > 0 ? (v.discount / v.gross) * 100 : null,
      };
    })
    .sort((a, b) => b.net - a.net);
}

// ---------------------------------------------------------------------------
// Hour of day
// ---------------------------------------------------------------------------

/**
 * Reproduces sales.vw_ebo_sales_hourly + computeHourlyPoints over lines.
 *
 * The view is `where bill_type = 'SALE' and bill_time is not null`, grouped by
 * extract(hour from bill_time), summing net_amount; computeHourlyPoints then
 * keeps only hours HOUR_START..HOUR_END. All three rules are reproduced.
 *
 * bill_time arrives from PostgREST as a "HH:MM:SS" string, so the hour is its
 * first field. A row whose time failed the view's own regex guard is NULL and
 * is skipped here — not placed at hour 0, which would invent a midnight peak.
 */
export function computeHourlyFromLines(lines: SaleLineRow[]): { hour: number; value: number }[] {
  const byHour = new Map<number, number>();
  for (const l of lines) {
    if (!isSale(l)) continue;
    const t = l.bill_time;
    if (!t) continue;
    const hour = Number(String(t).slice(0, 2));
    if (!Number.isFinite(hour) || hour < HOUR_START || hour > HOUR_END) continue;
    byHour.set(hour, (byHour.get(hour) ?? 0) + numOf(l.net_amount));
  }
  return [...byHour.entries()].sort((a, b) => a[0] - b[0]).map(([hour, value]) => ({ hour, value }));
}

// ---------------------------------------------------------------------------
// Scheme penetration
// ---------------------------------------------------------------------------

export const NO_SCHEME = "NO SCHEME";

export type SchemeAgg = { schemeRows: [string, { qty: number; net: number }][]; schemeMaxQty: number };

/**
 * Reproduces sales.vw_ebo_bill's dominant-scheme rule + vw_ebo_scheme_daily +
 * computeSchemeRows over lines.
 *
 * Scheme penetration is a BILL-grain idea, not a line-grain one. vw_ebo_bill
 * assigns each bill a single `dominant_scheme_group` — the scheme_group_name
 * with the largest summed net_amount on that bill (distinct on ... order by
 * group_net desc) — and vw_ebo_scheme_daily then sums each bill's SALE
 * quantity and net under that one group, bucketing bills with no scheme at all
 * as 'NO SCHEME'. Reproduced exactly.
 *
 * WHAT THE ATTRIBUTE FILTER CHANGES, STATED PLAINLY: dominance is resolved
 * over the lines that SURVIVE the filter, not over the whole bill. Filtering
 * to DRESSES and asking "which scheme is winning" is a question about the
 * dresses on those bills, so the dress lines are what should decide both the
 * bill's dominant scheme and the quantity credited to it. With no attribute
 * filter active every line survives and this is bit-for-bit the view's own
 * answer.
 */
export function computeSchemeFromLines(lines: SaleLineRow[]): SchemeAgg {
  type Bill = { schemeNet: Map<string, number>; saleQty: number; saleNet: number };
  const bills = new Map<string, Bill>();

  for (const l of lines) {
    const key = billKeyOf(l);
    let b = bills.get(key);
    if (!b) {
      b = { schemeNet: new Map(), saleQty: 0, saleNet: 0 };
      bills.set(key, b);
    }
    const net = numOf(l.net_amount);
    const group = l.scheme_group_name;
    // The dominance CTE has no bill_type filter — it ranks over every line
    // carrying a scheme group, so this does too.
    if (group) b.schemeNet.set(group, (b.schemeNet.get(group) ?? 0) + net);
    if (isSale(l)) {
      b.saleQty += numOf(l.total_quantity);
      b.saleNet += net;
    }
  }

  const byGroup = new Map<string, { qty: number; net: number }>();
  for (const b of bills.values()) {
    let dominant = NO_SCHEME;
    let best = -Infinity;
    for (const [g, n] of b.schemeNet) {
      if (n > best) {
        best = n;
        dominant = g;
      }
    }
    const cur = byGroup.get(dominant) ?? { qty: 0, net: 0 };
    cur.qty += b.saleQty;
    cur.net += b.saleNet;
    byGroup.set(dominant, cur);
  }

  const schemeRows = [...byGroup.entries()].sort(([, a], [, b]) => b.net - a.net);
  const schemeMaxQty = Math.max(...schemeRows.map(([, v]) => v.qty), 1);
  return { schemeRows, schemeMaxQty };
}

// ---------------------------------------------------------------------------
// Agent-wise
// ---------------------------------------------------------------------------

export type LineAgentRow = { storeId: string; agent: string; bills: number; qty: number; net: number };

/**
 * Reproduces sales.vw_ebo_agent_daily + computeAgentRows over lines.
 *
 * The view is `where bill_type = 'SALE'`, grouping on
 * coalesce(agent_name, 'Unassigned') with bills = count(distinct bill_no);
 * computeAgentRows then strips the "001 - " branch-code prefix for DISPLAY
 * only (grouping stays on the raw name + store, because two agents can share
 * a first name across stores and the prefix is sometimes the only thing
 * telling them apart) and cuts to the top 12 by net. All reproduced.
 */
export function computeAgentRowsFromLines(lines: SaleLineRow[]): LineAgentRow[] {
  const cleanAgentName = (name: string) => name.replace(/^\d+\s*-\s*/, "").trim();
  const byAgent = new Map<string, { storeId: string; agent: string; qty: number; net: number; billKeys: Set<string> }>();

  for (const l of lines) {
    if (!isSale(l)) continue;
    const sid = l.store_id;
    if (!sid) continue;
    const rawName = l.agent_name ?? "Unassigned";
    const key = `${sid}::${rawName}`;
    let cur = byAgent.get(key);
    if (!cur) {
      cur = { storeId: sid, agent: cleanAgentName(rawName), qty: 0, net: 0, billKeys: new Set() };
      byAgent.set(key, cur);
    }
    cur.qty += numOf(l.total_quantity);
    cur.net += numOf(l.net_amount);
    cur.billKeys.add(billKeyOf(l));
  }

  return [...byAgent.values()]
    .map(({ storeId, agent, qty, net, billKeys }) => ({ storeId, agent, qty, net, bills: billKeys.size }))
    .sort((a, b) => b.net - a.net)
    .slice(0, 12);
}

// ---------------------------------------------------------------------------
// Fresh / EOSS classification
// ---------------------------------------------------------------------------

/**
 * The ERP rounds to whole rupees, which lands real "FLAT 50% OFF" lines at
 * 49.94%-50.00% of gross. 0025 widened the threshold to 0.495 to absorb that
 * and every Fresh/Discounted view since (0032, 0058) carries the same number.
 * Do NOT "tidy" this to 0.5 — see 0025's header.
 */
const EOSS_DISCOUNT_RATIO = 0.495;

/**
 * Is this ONE line EOSS (what /targets calls "Discounted")?
 *
 * Copied from core.app_settings.fresh_disc_classification_source's DEFAULT
 * 'discount_ratio' branch (0058, which is 0023 + 0025's tolerance):
 *
 *   gross_amount = 0 OR discount_amount / gross_amount < 0.495  -> Fresh
 *   otherwise                                                   -> Discounted
 *
 * The other branch, 'scheme_lookup', is an admin-configurable alternative set
 * on the Targets page and is deliberately NOT implemented here: it needs
 * raw_logic.scheme_lookup joined per item_code, which this view does not
 * carry. If that setting is ever switched on, these columns will disagree with
 * the Targets tracker — stated here rather than discovered later.
 *
 * discount_amount is NOT a column on sales.vw_ebo_sale_attribute_lines and
 * does not need to be. The canonical definition everywhere in this schema
 * (0094's vw_ebo_sales_lines, which 0058 reads) is
 * `gross_amount - coalesce(net_amount, gross_amount)`, and this view's
 * net_amount column is ALREADY `coalesce(st.net_amount, st.gross_amount)`
 * (0092) — so gross - net computed here is that expression exactly, not an
 * approximation of it. Adding a stored column would have been a second
 * definition of a pure function of two columns already present.
 *
 * CLASSIFICATION IS PER LINE, then summed — never "sum the range, then
 * classify". A range whose overall discount is 40% can still be half EOSS
 * units, and the aggregate would hide every one of them.
 */
export function isEossLine(l: SaleLineRow): boolean {
  const gross = numOf(l.gross_amount);
  if (gross === 0) return false;
  const discount = gross - numOf(l.net_amount);
  return discount / gross >= EOSS_DISCOUNT_RATIO;
}

export type QtySplit = { freshQty: number; eossQty: number; totalQty: number };

/**
 * Fresh / EOSS / Total unit split for a line set.
 *
 * RETURN LINES ARE EXCLUDED, NOT NETTED — a deliberate choice, per the brief's
 * instruction to decide rather than default. Two reasons:
 *
 *   1. `totalQty` here must equal the "Qty" column these three replace, and
 *      that column has ALWAYS been SALE-only (computeTotalsFromLines,
 *      lineRollups' accumulate(), vw_ebo_sales_daily's own sale_quantity).
 *      Netting returns in would silently move an existing published number
 *      while appearing to only add two columns beside it.
 *   2. A return's Fresh/EOSS bucket is not reliably its original sale's. The
 *      credited amount can differ from the sold amount, so a return line's own
 *      discount ratio can classify it into the opposite bucket from the unit
 *      it is reversing — netting it would then ADD a unit to one bucket while
 *      removing one from the other. There is no bill-to-original-bill link in
 *      this view to do it correctly.
 *
 * This does mean a heavy-return window shows a Total qty above the units that
 * stayed sold. That is exactly what the existing Qty column already showed;
 * the money columns beside it (net, all bill types) still net returns off.
 */
export function computeQtySplitFromLines(lines: SaleLineRow[]): QtySplit {
  let freshQty = 0;
  let eossQty = 0;
  for (const l of lines) {
    if (!isSale(l)) continue;
    const q = numOf(l.total_quantity);
    if (isEossLine(l)) eossQty += q;
    else freshQty += q;
  }
  return { freshQty, eossQty, totalQty: freshQty + eossQty };
}

// ---------------------------------------------------------------------------
// Daily trend + headline totals
// ---------------------------------------------------------------------------

/**
 * Daily net-sales points, all bill types summed as stored (returns already
 * negative) — the same definition vw_ebo_sales_daily's net_sales carries and
 * the same {label, value, date} shape TrendChart/ComparisonTrendChart need,
 * where `date` is the raw ISO the time scale zooms against.
 */
export function computeTrendFromLines(lines: SaleLineRow[]): { label: string; value: number; date: string }[] {
  const byDate = new Map<string, number>();
  for (const l of lines) {
    if (!l.bill_date) continue;
    byDate.set(l.bill_date, (byDate.get(l.bill_date) ?? 0) + numOf(l.net_amount));
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => ({ label: date, value, date }));
}

export type LineTotals = {
  net: number;
  gross: number;
  discount: number;
  qty: number;
  bills: number;
  atv: number | null;
  upt: number | null;
  discountPct: number | null;
};

/** Headline totals for a line set — every ratio from summed parts, never averaged. */
export function computeTotalsFromLines(lines: SaleLineRow[]): LineTotals {
  let net = 0;
  let gross = 0;
  let qty = 0;
  const billKeys = new Set<string>();
  for (const l of lines) {
    net += numOf(l.net_amount);
    gross += numOf(l.gross_amount);
    if (isSale(l)) {
      qty += numOf(l.total_quantity);
      billKeys.add(billKeyOf(l));
    }
  }
  const bills = billKeys.size;
  const discount = gross - net;
  return {
    net,
    gross,
    discount,
    qty,
    bills,
    atv: bills > 0 ? net / bills : null,
    upt: bills > 0 ? qty / bills : null,
    discountPct: gross > 0 ? (discount / gross) * 100 : null,
  };
}
