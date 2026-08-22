-- =============================================================================
-- 0076 · Fix: sales.vw_item_subcategory_lookup's catastrophic join cost.
-- =============================================================================
-- Found auditing the /targets audit-report timeout. This view's only job is
-- item_code -> subcategory/gender, and it computed that by joining
-- raw_logic.item_master with a FALLBACK to the latest raw_logic.stock_snapshot
-- row per item (a ROW_NUMBER() window over all 46k+ snapshot rows) whenever
-- item_master lacked the fields. Every downstream caller
-- (ops.vw_monthly_fresh_disc_audit_lines and its siblings, 7 migrations deep)
-- pays for that window recomputation once per outer row when the planner
-- picks a Nested Loop — confirmed live: forcing a Hash Join instead
-- (`set enable_nestloop = off`) dropped the same real query from a 15s+
-- timeout to 224ms. A composite index and fresh ANALYZE were tried first and
-- neither changed anything — this is a query-shape problem, not a stats/
-- index problem.
--
-- The fallback itself turned out to be dead weight, not a real need: checked
-- live —
--   - item_master has 93,291 rows, ZERO missing subcategory or gender.
--   - EVERY item_code in stock_snapshot already has an item_master row too
--     (zero orphans).
-- So the stock_snapshot fallback branch has never actually fired for any
-- real item. Removing it is behavior-neutral today, not just faster.
--
-- Rewritten as a direct, index-backed read of item_master — no window
-- function, no stock_snapshot join at all.
-- =============================================================================

create or replace view sales.vw_item_subcategory_lookup as
select
  item_code,
  nullif(trim(subcategory), '') as subcategory,
  nullif(trim(gender), '') as gender
from raw_logic.item_master;

comment on view sales.vw_item_subcategory_lookup is
  'item_code -> subcategory/gender, read directly from raw_logic.item_master (the authoritative product-details table, 0056). Previously fell back to a windowed scan of raw_logic.stock_snapshot for items missing these fields in item_master — removed 2026-08-22 after confirming live that item_master has zero such gaps and that fallback path was the cause of catastrophic query plans (a Nested Loop re-running the window function once per outer row) in every downstream Targets audit view.';

notify pgrst, 'reload schema';
