-- =============================================================================
-- 0025 · 50%-off rule: tolerate the ERP's rupee-rounding drift below 50.000%
-- =============================================================================
-- 0023 implemented the business rule "Discounted = discount is 50% or more of
-- gross" as a strict discount_amount / gross_amount >= 0.5. Verified against
-- the real Sale report after 0023 went live, that strict threshold puts a
-- large slice of genuinely-half-price lines in the FRESH bucket, which is the
-- opposite of what the rule was asked for:
--
--   scheme_name = 'FLAT 50% OFF'   2375 lines total
--                                  1586 land at exactly 50.000%  -> Discounted
--                                   789 land at 49.937%-49.995%  -> Fresh (!)
--
-- The cause is arithmetic, not data quality: Logic ERP rounds the discounted
-- price to whole rupees, so a 1199 MRP line sells at 600, not 599.50, and the
-- computed ratio is 49.958% rather than 50%. A line the ERP itself labels
-- "FLAT 50% OFF" must not fall into the Fresh table — the user's rule names
-- that scheme explicitly ("flat 50% off or where discount is 50% and above").
--
-- Fix: threshold at 0.495 (49.5%) instead of 0.5. Chosen because the real data
-- has a wide empty gap on either side of it — verified live across all 20,975
-- rows, the discount-ratio distribution has NOTHING between 45% and 49.796%:
--
--   ... 29.8%, 30.0%, 32.2%  <- FLAT 30% OFF, B1G40%&B2G50%, B2G1FREE tiers
--   [ empty band, 45.0% .. 49.796% ]
--   49.796% .. 50.000%       <- 4437 lines: 789 'FLAT 50% OFF', 25 'B1G40% &
--                               B2 OR MORE G50%', 3623 with a blank scheme
--                               name but priced at half MRP all the same
--
-- So 0.495 cleanly separates "meant to be half price, rounded" from the next
-- real discount tier down (32%) without needing to special-case scheme names,
-- which is what 0023 deliberately stopped doing. If the business ever
-- introduces a genuine 46-49% scheme this needs revisiting — that band is
-- empty today, and that emptiness is the whole justification for 0.495.
--
-- Net effect on the numbers the Targets page shows (Undri, Aug 2026, as a
-- worked example): Fresh 104 -> 58, Discounted 119 -> 165. Same total.
--
-- To revert to the strict reading, re-run 0023 as-is; nothing else in this
-- migration to undo. Only the actual_daily CTE changes, same as 0023 — the
-- view's column list and output shape are untouched, so
-- web/app/(ho)/targets/page.tsx's TrackerRow type still matches exactly.
-- =============================================================================

create or replace view ops.vw_monthly_fresh_disc_tracker
with (security_invoker = on) as
with actual_daily as (
  select
    store_id,
    bill_date,
    sum(total_quantity) filter (
      where gross_amount = 0 or (discount_amount / gross_amount) < 0.495
    )                                                                as fresh_actual_qty,
    sum(total_quantity) filter (
      where gross_amount <> 0 and (discount_amount / gross_amount) >= 0.495
    )                                                                as discounted_actual_qty
  from sales.vw_ebo_sales_lines
  group by store_id, bill_date
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
  'Spans every day of the target''s month, including future days (actual = 0). The app is responsible for only rendering rows up to today — this view does not know "today". Fresh/Discounted split (0023, tolerance added in 0025): Discounted = discount_amount/gross_amount >= 0.495, everything else (including gross_amount = 0) is Fresh. The 0.495 rather than 0.50 absorbs the ERP''s whole-rupee price rounding, which lands real "FLAT 50% OFF" lines at 49.94-50.00%. No longer based on scheme_group_name presence.';

grant select on ops.vw_monthly_fresh_disc_tracker to authenticated;
