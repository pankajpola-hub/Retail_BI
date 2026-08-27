import "server-only";

/**
 * EBO fiscal year: April-March, in the 8-digit form the sale_detail source
 * view uses ("eight digits, e.g. 20262027", per sale_detail_reference.md) —
 * the same Apr-start boundary as sales.vw_sale_transactions_export's (0086)
 * financial_year, just numeric instead of the view's "FY2026-27" text form.
 *
 * Single copy shared by app/api/cron/sale-detail-sync (which has always
 * bounded its scan this way) and app/api/sales-source/sale-detail (which
 * did not — audit B-05: it scanned the entire view, every store and every
 * fiscal year, on every request). Two independent copies of a fiscal-year
 * boundary is exactly the kind of thing that silently drifts, hence one
 * module rather than a second local function.
 */
export function currentFinYear(d: Date): number {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1; // 1-12
  return m >= 4 ? y * 10000 + (y + 1) : (y - 1) * 10000 + y;
}
