-- =============================================================================
-- 0051 · Correct one factual claim written by 0050. CATALOGUE TEXT ONLY —
--        no view, no function, no displayed number, and no source_view /
--        source_column is touched. 0050 is already applied, and this project
--        never edits an applied migration (HANDOFF.md), so the correction
--        ships as its own file.
--
-- WHAT 0050 GOT WRONG
--
-- 0050 asserted that the sale-bills-only ATV numerator is "NOT re-derivable
-- from vw_ebo_sales_daily's exposed columns" because sale_net_amount is
-- CTE-internal (0005:91). That is too strong. The daily view also exposes
-- net_sales (all bill types, 0005:104) and returns_value (the RETURN slice,
-- 0005:105), so:
--
--     net_sales - returns_value  =  SALE + OTHER
--     sale_net_amount            =  SALE
--
-- Those are equal ONLY when the scope contains no OTHER-type bills.
-- bill_type is a three-way classification, not two (0036:37-41):
--     bill_no like '%SB-%' -> 'SALE'
--     bill_no like '%RB-%' -> 'RETURN'
--     everything else      -> 'OTHER'
--
-- So the honest statement is CONDITIONAL: recoverable as
-- net_sales - returns_value when the scope has no OTHER bills, and not
-- recoverable at all when it does — because OTHER's contribution to
-- net_sales cannot be separated out from any exposed column.
--
-- HOW THIS SURFACED, and why it is not proof of anything
--
-- scripts/parity-check.mjs asserts the identity per day and it PASSED. But
-- the local dev dataset contains 2 SALE lines and nothing else — zero RETURN
-- bills and zero OTHER bills — so the identity held vacuously. A green run
-- on this fixture says nothing about a real store's data, where OTHER bills
-- may well exist. The parity script's own banner already makes the parallel
-- point about ATV's grain being untestable here; this is the same limitation
-- reached from the other side.
--
-- Nothing about the 0050 correction itself is affected: 'atv' still belongs
-- against the weekly view (that was never in question — it is what the app
-- renders), and atv_sale_bills_only still correctly describes the daily
-- column. Only the parenthetical about re-derivability was overstated.
-- =============================================================================

update workspace.metric_definitions set
  rollup_strategy =
    'Re-derive from a sale-bills-only net amount / sale_bills. Recoverability from '
    'sales.vw_ebo_sales_daily''s EXPOSED columns is conditional: sale_net_amount itself is '
    'CTE-internal (0005:91), but net_sales - returns_value (0005:104 minus 0005:105) equals it '
    'WHENEVER the scope contains no OTHER-type bills. bill_type is three-way — SALE / RETURN / '
    'OTHER (0036:37-41) — so where OTHER bills exist, net_sales - returns_value = SALE + OTHER '
    'and this metric is NOT recoverable at that grain. Check for OTHER bills before relying on '
    'the subtraction. Corrects an overstatement in migration 0050''s header.'
where id = 'atv_sale_bills_only';

notify pgrst, 'reload schema';
