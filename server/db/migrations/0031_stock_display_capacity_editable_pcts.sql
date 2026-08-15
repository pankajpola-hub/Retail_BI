-- =============================================================================
-- 0031 · Stock Details — admin-editable buffer % and Fresh/EOSS split %
-- =============================================================================
-- The Stock Details "Capacity update window" (ops.stock_display_capacity,
-- migration 0026) derives Buffered and Fresh/EOSS from base_capacity using
-- two constants hardcoded in lib/stockDetails/aggregate.ts:
--   bufferedCapacity = base_capacity * 1.10          (110% buffer)
--   freshCapacity    = bufferedCapacity * 0.35        (35% Fresh)
--   eossCapacity     = bufferedCapacity * 0.65        (65% EOSS)
-- Per user feedback, admins should be able to override both the buffer
-- multiplier and the Fresh/EOSS split, at the same granularity base_capacity
-- already has (per store x gender x age_segment — one row per block, 4 rows
-- per store), not globally. eoss_pct is not stored: the app always derives
-- it as 100 - fresh_pct (same "complement, not independently recomputed"
-- pattern buildDcMatrix's split() already uses for freshPct/eossPct, so the
-- two can never drift apart or fail to sum to 100).
--
-- Both new columns are nullable and default to nothing (NULL), not 110/35 —
-- the app (buildCapacityPlan in lib/stockDetails/aggregate.ts) treats NULL
-- as "use the hardcoded default", so every existing row and every store that
-- never customizes these keeps behaving exactly as before this migration.
-- Only rows where an admin has explicitly typed a percentage get a non-null
-- value. This mirrors base_capacity's own "0 until an admin sets it" pattern
-- without reusing 0 as a sentinel (0% buffer or 0% fresh are meaningless, so
-- NULL is the only safe "unset" marker here).
--
-- No RLS/policy changes needed: these columns live on the same table and row
-- as base_capacity, so the existing stock_display_capacity_insert/update
-- policies (ho_admin/super_admin only) and the existing updated_by/updated_at
-- audit trail (touched by the same trg_stock_display_capacity_touch_updated_at
-- trigger) already cover writes to these fields — editing a block's % now
-- updates the same audit columns editing its base_capacity already did.

alter table ops.stock_display_capacity
  add column buffer_pct numeric check (buffer_pct is null or buffer_pct > 0),
  add column fresh_pct  numeric check (fresh_pct is null or (fresh_pct >= 0 and fresh_pct <= 100));

comment on column ops.stock_display_capacity.buffer_pct is
  'Admin override for the buffer multiplier, as a percentage (110 = 110%, i.e. base * 1.10). NULL = use the app-wide default (110%).';
comment on column ops.stock_display_capacity.fresh_pct is
  'Admin override for the Fresh share of buffered capacity, as a percentage (35 = 35% Fresh / 65% EOSS). NULL = use the app-wide default (35%). EOSS share is always 100 - fresh_pct, never stored separately.';
