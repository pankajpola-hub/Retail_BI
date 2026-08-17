-- =============================================================================
-- 0046 · Phase 1 performance: close two index gaps flagged in the
--        architecture audit (Retail Intelligence Workspace blueprint, §D/§G)
-- =============================================================================
-- Both are additive only — no existing index dropped, no behavior changed,
-- no RLS policy touched. Just coverage for columns that are already filtered
-- on every request but currently force a sequential scan.
--
-- 1) marketing.campaign_stores.store_id is the RLS filter column for
--    campaign_stores_read (0010), but store_id is only the SECOND column of
--    the table's composite PK (campaign_id, store_id) — a per-store lookup
--    can't use that PK efficiently. Small table today; flagged so it doesn't
--    become a silent full-scan as campaigns accumulate.
create index if not exists idx_campaign_stores_store_id
  on marketing.campaign_stores (store_id);

-- 2) ops.ebo_footfall_daily.date has no standalone index — only covered as
--    the second column of the (store_id, date) unique constraint. The
--    store-health and diagnosis functions (0008/0009) both do cross-store
--    date-range scans over this table, which that composite index can't
--    serve without a store_id predicate first.
create index if not exists idx_ebo_footfall_daily_date
  on ops.ebo_footfall_daily (date);
