-- =============================================================================
-- 0027 · Exclude accessory subcategories from the Fresh/Discounted tracker
-- =============================================================================
-- ops.vw_monthly_fresh_disc_tracker (0020, reclassified in 0023) sums
-- total_quantity from sales.vw_ebo_sales_lines with no regard to product
-- category, because raw_logic.sales_transactions has no category column —
-- only item_code. Real product data now exists in raw_logic.stock_snapshot
-- (0024), which carries item_code + subcategory, and item_code is confirmed
-- to be the same join key used across sales/stock/scheme data (real barcodes
-- match across all three real uploaded reports).
--
-- Business ask: exclude accessory lines from the tracker's Fresh/Discounted
-- sale-quantity counts entirely — not reclassify them into the other bucket,
-- drop them from both, so the total counted quantity goes DOWN. Verified
-- live against the actual uploaded Stock report's distinct SUBCATEGORY
-- values (2026-08-12, 5182 rows) — exactly the 37 values expected, no
-- trailing/blank variants, no unrecognised subcategory. Six are accessories,
-- not garments: BOW CLIP, HAIR CLIP, HAIRBAND, SCRUNCHIE, NECKLACE, WAIST
-- CHAIN. Everything else (DRESS, TOP, SHIRT, PANTS, JOGGERS, etc.) is
-- clothing and stays counted. No ambiguous/unrecognised value was found, so
-- no judgment call beyond this list was needed.
--
-- -----------------------------------------------------------------------------
-- sales.vw_item_subcategory_lookup — item_code -> subcategory, one row each
-- -----------------------------------------------------------------------------
-- raw_logic.stock_snapshot is a full-replace snapshot (0024's header: wiped
-- and reloaded whole on every stock-report upload), not a permanent item
-- master, and it has no unique constraint on item_code (multiple rows per
-- item across branches/sizes). Verified live: today's snapshot has zero
-- item_codes that map to more than one distinct subcategory (5182 rows,
-- 3732 distinct item_codes, 0 conflicts) — but that's a fact about today's
-- data, not a schema guarantee, so this view still resolves deterministically
-- via row_number() rather than a plain DISTINCT, which would silently
-- fan-out (and double-count downstream sums) the day a future upload ever
-- does carry a genuine conflict.
--
-- security_invoker = off + security_barrier = true, same reasoning as
-- sales.vw_stock_with_scheme (0024) and sales.vw_ebo_sales_lines (0015):
-- raw_logic keeps zero grants to authenticated (0001), so this view must run
-- as its owner to reach raw_logic.stock_snapshot at all. There is no row-level
-- access control to preserve here — a subcategory lookup by item_code isn't
-- store-scoped or sensitive, same posture as vw_stock_with_scheme.
-- NOTE (applied out of order, lead review pass): this migration was written
-- assuming sales.vw_item_subcategory_lookup did not exist yet, but 0022-0030
-- were pushed to production before this file ever ran, and migration 0029
-- already created a superset version of this view (adds `gender` alongside
-- `subcategory`). CREATE OR REPLACE VIEW cannot drop a column, so re-running
-- the original 2-column CREATE here would fail against the live 3-column
-- version. Skipped — 0029's version already satisfies everything this
-- section needed (item_code -> subcategory resolution, same row_number()
-- dedup logic). See 0029 for the actual live definition.
grant select on sales.vw_item_subcategory_lookup to authenticated;

-- -----------------------------------------------------------------------------
-- Tracker view: same 0.5-of-gross Fresh/Discounted split as 0023 (the
-- currently-live logic — see note below), now with accessory lines dropped
-- from BOTH sums rather than counted in either. Only the actual_daily CTE
-- changes; every other column, the spine/pacing logic, and the view's output
-- shape are untouched, so web/app/(ho)/targets/page.tsx's TrackerRow type
-- still matches exactly.
--
-- NOTE on 0025: a migration file 0025_fresh_disc_50pct_rounding_tolerance.sql
-- (0.5 -> 0.495 threshold) exists in this migrations folder but had NOT been
-- applied to the live database as of this migration (confirmed by reading
-- the live view definition directly: still the strict >= 0.5 from 0023).
-- This migration deliberately builds on the CURRENTLY LIVE 0.5 threshold —
-- i.e. 0023's logic, unchanged — and does NOT fold in 0025's tolerance
-- change, to stay narrowly scoped to the accessory-exclusion task this
-- migration is for. Whoever owns 0025 needs to apply it AFTER this one (or
-- re-CREATE OR REPLACE with both changes together) — applying 0025 alone on
-- top of this would silently drop the accessory exclusion below, since
-- CREATE OR REPLACE VIEW fully replaces the query body. Flagged here so that
-- isn't a silent surprise.
--
-- UPDATE (0032): this file is being pushed to production together with
-- 0023 and 0025, in filename order (0023 -> 0025 -> 0027 -> ... -> 0032), so
-- by the time THIS statement runs the live view already has 0025's 0.495
-- tolerance applied. The CREATE OR REPLACE VIEW below reintroduces the
-- strict 0.5 threshold exactly as originally written in this file — 0032
-- restores 0.495 immediately afterward in its own tracker-function work and
-- additionally re-patches this view directly (see 0032) so the view doesn't
-- end this push sequence back on the stale 0.5 threshold. Left byte-for-byte
-- as originally authored here (not touched) so this file's own history stays
-- an honest record of what it did at the time.
create or replace view ops.vw_monthly_fresh_disc_tracker
with (security_invoker = on) as
with actual_daily as (
  select
    l.store_id,
    l.bill_date,
    sum(l.total_quantity) filter (
      where not coalesce(sub.subcategory in (
              'BOW CLIP', 'HAIR CLIP', 'HAIRBAND', 'SCRUNCHIE', 'NECKLACE', 'WAIST CHAIN'
            ), false)
        and (l.gross_amount = 0 or (l.discount_amount / l.gross_amount) < 0.5)
    )                                                                as fresh_actual_qty,
    sum(l.total_quantity) filter (
      where not coalesce(sub.subcategory in (
              'BOW CLIP', 'HAIR CLIP', 'HAIRBAND', 'SCRUNCHIE', 'NECKLACE', 'WAIST CHAIN'
            ), false)
        and l.gross_amount <> 0 and (l.discount_amount / l.gross_amount) >= 0.5
    )                                                                as discounted_actual_qty
  from sales.vw_ebo_sales_lines l
  left join sales.vw_item_subcategory_lookup sub on sub.item_code = l.item_code
  group by l.store_id, l.bill_date
),
spine as (
  select
    t.id                    as target_id,
    t.store_id,
    t.period_month,
    t.fresh_target_qty,
    t.discounted_target_qty,
    d::date                 as date,
    (extract(day from ((t.period_month + interval '1 month' - interval '1 day')))::int) as days_in_month
  from ops.ebo_monthly_targets t
  cross join lateral generate_series(
    t.period_month,
    (t.period_month + interval '1 month' - interval '1 day')::date,
    interval '1 day'
  ) d
)
select
  sp.target_id,
  sp.store_id,
  sp.period_month,
  sp.date,
  to_char(sp.date, 'Dy')                                    as day_name,
  extract(day from sp.date)::int                            as day_of_month,
  sp.days_in_month,
  sp.fresh_target_qty,
  sp.discounted_target_qty,
  coalesce(a.fresh_actual_qty, 0)                           as fresh_actual_qty,
  coalesce(a.discounted_actual_qty, 0)                      as discounted_actual_qty,
  sum(coalesce(a.fresh_actual_qty, 0))
    over (partition by sp.target_id order by sp.date)       as fresh_cum_qty,
  sum(coalesce(a.discounted_actual_qty, 0))
    over (partition by sp.target_id order by sp.date)       as discounted_cum_qty,
  round(sp.fresh_target_qty::numeric * extract(day from sp.date) / sp.days_in_month, 1)
                                                              as fresh_mtd_target,
  round(sp.discounted_target_qty::numeric * extract(day from sp.date) / sp.days_in_month, 1)
                                                              as discounted_mtd_target
from spine sp
left join actual_daily a on a.store_id = sp.store_id and a.bill_date = sp.date
where sp.store_id = any (core.fn_user_store_ids())
order by sp.store_id, sp.date;

comment on view ops.vw_monthly_fresh_disc_tracker is
  'Spans every day of the target''s month, including future days (actual = 0). The app is responsible for only rendering rows up to today — this view does not know "today". Fresh/Discounted split (0023): Discounted = discount_amount/gross_amount >= 0.5, everything else (including gross_amount = 0) is Fresh. Accessory subcategories (0027: BOW CLIP, HAIR CLIP, HAIRBAND, SCRUNCHIE, NECKLACE, WAIST CHAIN, via sales.vw_item_subcategory_lookup on item_code) are excluded from BOTH sums entirely, not shifted between them. A line whose item_code has no match in the current stock snapshot is NOT excluded (can''t confirm it''s an accessory).';

grant select on ops.vw_monthly_fresh_disc_tracker to authenticated;

-- -----------------------------------------------------------------------------
-- Line-level audit view — backs the /targets downloadable audit report.
-- -----------------------------------------------------------------------------
-- NOTE (applied out of order, lead review pass): same issue as the lookup
-- view above — 0029 already created ops.vw_monthly_fresh_disc_audit_lines
-- with a superset of columns (line_id, gender, scheme_name,
-- scheme_group_name, reason). Re-running this migration's narrower original
-- CREATE would drop those columns, which Postgres disallows. Skipped — 0029's
-- version already includes this migration's bucket/subcategory logic plus
-- more. See 0029 for the actual live definition.
grant select on ops.vw_monthly_fresh_disc_audit_lines to authenticated;
