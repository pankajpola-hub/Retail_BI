-- =============================================================================
-- 0013 · Fix the same missing-grant bug across every remaining base table
-- =============================================================================
-- 0012 fixed core.profiles / core.user_store_access after it broke login.
-- Auditing every other RLS-protected base table turned up the identical gap
-- on all of them: a correct RLS policy was written, but the base-table
-- GRANT that must exist before Postgres even considers RLS was never added.
-- Each of these would have failed exactly like login did, one feature at a
-- time, as they were built out. Grants below are scoped to match exactly
-- what each table's existing RLS policies already allow — see the migration
-- that defines each policy for the authorization logic itself; this file
-- only adds the privilege layer underneath it.

-- ops — footfall, targets, action queue, health config, stock stub
grant select, insert, update on ops.ebo_footfall_daily        to authenticated; -- footfall_read / _write / _update
grant select, insert, update on ops.ebo_targets                to authenticated; -- targets_read / _write / _update
grant select, insert, update on ops.action_items                to authenticated; -- action_items_read / _insert / _update
grant select, insert, update, delete on ops.health_score_factors to authenticated; -- health_factors_read (all) / _write (ho_admin/super_admin only, via RLS)
grant select on ops.stock_availability_snapshot                   to authenticated; -- stock_snapshot_read — write is service-role/Phase 2 only, no write policy exists yet

-- marketing — campaigns, recipients, import batches
grant select, insert, update on marketing.campaigns                  to authenticated; -- campaigns_read / _write / _update
grant select, insert         on marketing.campaign_stores             to authenticated; -- campaign_stores_read / _write
grant select, insert, update on marketing.campaign_recipients          to authenticated; -- read/write policies; update needed for the ON CONFLICT DO UPDATE upsert pattern in supabase/README.md
grant select, insert, update, delete on marketing.campaign_import_batches to authenticated; -- import_batches_rw is `for all`
