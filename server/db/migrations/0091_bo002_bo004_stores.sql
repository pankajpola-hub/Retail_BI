-- =============================================================================
-- 0091 · Register BO-002 (Baramati) and BO-004 (Lucknow) — inactive
-- =============================================================================
-- Both appear in sale_detail's own branch list (sale_detail_reference.md)
-- but were missing from core.stores entirely — BO-004 already had ten
-- files' worth of `s.store_id !== "BO-004"` filters (with comments
-- explaining it's discontinued), which turn out to have been no-ops all
-- along since the row was never actually in this table. BO-002 was never
-- referenced anywhere in the app before now.
--
-- Per Pankaj (2026-08-26): both branches are not currently operational.
-- Added with is_active = false (the column core.stores already had for
-- exactly this, unused everywhere in app code today) so their real-world
-- status is represented, and so sales.vw_sale_transactions_export's LEFT
-- JOIN to core.stores can still resolve a store_name for their rows once
-- api/cron/sale-detail-sync starts writing them, rather than a silent
-- null. Per-store dashboard aggregations (Replenishment, Sale vs Stock
-- Mix, Network, Workspace, Targets, Stock Details, Footfall, Users) stay
-- clean via the SAME existing exclusion mechanism already used for
-- BO-004 in those ten files — extended to cover BO-002 too, in this same
-- change, rather than switching to an is_active-driven filter (a bigger,
-- unrequested change to a convention already established across ten
-- files).
--
-- city/region are a best-effort read of sale_detail_reference.md's branch
-- names ("BO-002 - BARAMATI - HI-TECH TEXTILE PARK", "BO-004 - LUCKNOW -
-- PHOENIX PALASSIO") — Baramati is in Maharashtra/West like the two
-- existing Pune stores, Lucknow is Uttar Pradesh/North. Correct if wrong;
-- neither is read by any per-store aggregation logic today (only
-- store_id/branch_name_erp/store_name are).

insert into core.stores (store_id, branch_name_erp, store_name, city, region, store_type, opened_date, is_active) values
  ('BO-002', 'BO-002 - BARAMATI - HI-TECH TEXTILE PARK', 'Baramati',         'Baramati', 'West',  'EBO', null, false),
  ('BO-004', 'BO-004 - LUCKNOW - PHOENIX PALASSIO',       'Phoenix Palassio', 'Lucknow',  'North', 'EBO', null, false)
on conflict (store_id) do nothing;

notify pgrst, 'reload schema';
