-- =============================================================================
-- 0093 · Backfill: restore the negative sign on sync-sourced RETURN rows
-- =============================================================================
-- raw_logic.sales_transactions stores amounts and quantities ALREADY SIGNED —
-- a RETURN row is negative. Two independent facts establish this as the
-- canonical convention, not a preference:
--
-- 1. The ERP's own "SALE REGISTER DETAILS" export — the report the business
--    reconciles against — emits returns negative (TOTAL QUANTITY -1,
--    GROSS AMOUNT -1149.50, NET AMOUNT -1150.00 for RB-52).
-- 2. Every Excel-uploaded row already in the table (19,254 of 24,010, covering
--    2024-12-05 .. 2026-05-23) stores them negative, and the entire
--    sales.vw_ebo_* reporting chain — vw_ebo_sales_lines -> vw_ebo_bill ->
--    vw_ebo_sales_daily/_weekly/_monthly, plus 0092's
--    vw_ebo_sale_attribute_lines — sums net_amount AS STORED with no sign
--    logic of its own. It requires the stored value to carry the sign.
--
-- The nightly sale_detail sync (0090) violated this: its route's toUnsigned()
-- helper applied Math.abs() to signed_net_amount / signed_gross_amount /
-- signed_quantity, so every RETURN row it wrote landed POSITIVE. Because the
-- reporting chain then ADDS those rows instead of subtracting them, the error
-- on every current-FY number is exactly 2x the returns value.
--
-- Measured against the user's own ERP export for 01-25 Aug 2026 (like-for-like,
-- excluding the partial final day): row counts, SALE values and RETURN
-- magnitudes matched the ERP EXACTLY — only the sign differed.
--
--            ERP (true)      App showed      Error
--   Undri    471 units       501 units       +30   (= 2 x 15 returned units)
--            Rs 5,85,315     Rs 6,21,403     +Rs 36,088
--   Sinhgad  522 units       572 units       +50   (= 2 x 25 returned units)
--            Rs 5,85,876     Rs 6,46,102     +Rs 60,226
--
-- Fiscal-year-to-date the inflation is 227 return rows: +454 units and
-- +Rs 5,58,398 across the network.
--
-- Ships together with two code changes in the same commit:
--   * app/api/cron/sale-detail-sync/route.ts — toUnsigned() -> toSigned(),
--     so future runs write the sign through instead of stripping it.
--   * lib/replenishment/compute.ts + lib/replenishment/mix.ts — the
--     `sign = bill_type === 'RETURN' ? -1 : 1` multiplication is REMOVED.
--     Those two files were the only consumers reading the values as unsigned,
--     which is why Replenishment and Sale-vs-Stock-Mix were wrong in the
--     opposite direction on Excel-era rows: an already-negative return got
--     negated into positive demand.
--
-- IDEMPOTENT BY CONSTRUCTION: the update forces `-abs(...)` rather than
-- multiplying by -1, so re-running it cannot flip correct rows back. It is
-- safe to run more than once, and safe to run after the code fix has already
-- landed (rows written by the fixed sync are already negative and are left
-- unchanged).
--
-- SCOPE GUARD: `source = 'sale_detail_sync'` restricts this to rows the sync
-- wrote. Excel-uploaded rows (source IS NULL) are already correct and are
-- never touched, which also keeps FY24-25 / FY25-26 data untouched — the
-- standing rule for this table.

begin;

-- Before: what we are about to change (informational, shows in psql output).
select
  'BEFORE' as stage,
  count(*)                as return_rows_wrong_sign,
  sum(total_quantity)     as qty_currently_positive,
  sum(net_amount)         as net_currently_positive
from raw_logic.sales_transactions
where source = 'sale_detail_sync'
  and bill_no like '%RB-%'
  and (total_quantity > 0 or net_amount > 0 or gross_amount > 0);

update raw_logic.sales_transactions
set
  total_quantity = -abs(total_quantity),
  gross_amount   = -abs(gross_amount),
  net_amount     = -abs(net_amount)
where source = 'sale_detail_sync'
  and bill_no like '%RB-%'
  and (total_quantity > 0 or net_amount > 0 or gross_amount > 0);

-- After: every sync RETURN row must now be negative. Expect
-- return_rows_still_positive = 0.
select
  'AFTER' as stage,
  count(*) filter (where total_quantity > 0 or net_amount > 0 or gross_amount > 0)
                          as return_rows_still_positive,
  count(*)                as total_sync_return_rows,
  sum(total_quantity)     as qty_now_negative,
  sum(net_amount)         as net_now_negative
from raw_logic.sales_transactions
where source = 'sale_detail_sync'
  and bill_no like '%RB-%';

commit;

notify pgrst, 'reload schema';
