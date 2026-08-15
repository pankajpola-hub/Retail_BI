-- =============================================================================
-- 0038 · Separate Fresh/Discounted remarks, not one shared per store/day
-- =============================================================================
-- ops.daily_target_remarks (0032) held ONE remark per (store_id, date),
-- rendered only on the Fresh table with a note that it "covers both tables"
-- (web/app/(ho)/targets/page.tsx). Direct user feedback (2026-08-12): the
-- user wants a separate remark for Fresh and for Discounted, each shown at
-- the end of its own table, not one shared box.
--
-- Table was empty in production (confirmed: select count(*) = 0) — no data
-- migration needed, straight schema change. Adds `bucket` to the primary
-- key rather than splitting into two tables, since every other column and
-- every RLS policy stays identical; only the grain changes.
alter table ops.daily_target_remarks
  add column bucket text not null default 'fresh' check (bucket in ('fresh', 'discounted'));

alter table ops.daily_target_remarks drop constraint daily_target_remarks_pkey;
alter table ops.daily_target_remarks add primary key (store_id, date, bucket);

-- The default above only exists to let `add column` succeed against an
-- (empty, but in principle non-empty) table in one step — every write from
-- here on always specifies bucket explicitly (see the app's remark-cell
-- component), so drop the default rather than let it mask a caller forgetting
-- to pass one.
alter table ops.daily_target_remarks alter column bucket drop default;

comment on table ops.daily_target_remarks is
  'One free-text remark per store per day PER BUCKET (0038: fresh or discounted, separately) — shown as a column at the end of each of the /targets daily Fresh/Discounted tables so store staff can note why that specific bucket''s sale was up or down. Independent of ops.ebo_monthly_targets — no FK to a specific target row, so a remark can exist even for a day whose month has no target set yet.';
