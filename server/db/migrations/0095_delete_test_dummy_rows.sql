-- =============================================================================
-- 0095 · C-12 — delete TESTBILL_*/TESTBRANCH dummy rows from production
-- =============================================================================
-- 35 rows with branch_name = 'TESTBRANCH' (bill_no TESTBILL_A-0..19,
-- TESTBILL_B-0..14), Rs 100 each = Rs 3,500 total, sit in
-- raw_logic.sales_transactions. Harmless to every dashboard number — no
-- store in core.stores has branch_name_erp = 'TESTBRANCH', so every view
-- that joins to core.stores (which is all of sales.vw_ebo_*) excludes them
-- automatically. They DO leak into sales.vw_sale_transactions_export (a
-- LEFT JOIN to core.stores, deliberately unscoped — see migration 0094's
-- C-13 comment on that view) and the "full merged history" download that
-- reads it.
--
-- Confirmed scope before writing this: exactly 35 rows, all branch_name =
-- 'TESTBRANCH' exactly (no near-miss variants, no rows where only bill_no
-- matches TESTBILL with a different branch_name).
--
-- Not idempotent in the usual sense (a DELETE can't be re-run to the same
-- effect once the rows are gone) but safe to re-run — the WHERE clause
-- matches nothing on a second run.

begin;

select
  'BEFORE' as stage,
  count(*) as test_rows,
  sum(net_amount) as test_rows_net_amount
from raw_logic.sales_transactions
where branch_name = 'TESTBRANCH';

delete from raw_logic.sales_transactions
where branch_name = 'TESTBRANCH';

select
  'AFTER' as stage,
  count(*) as test_rows_remaining
from raw_logic.sales_transactions
where branch_name = 'TESTBRANCH';

commit;

notify pgrst, 'reload schema';
