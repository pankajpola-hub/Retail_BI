-- =============================================================================
-- 0055 · ops.vw_monthly_fresh_disc_tracker — drop the hardcoded accessory
-- exclusion so the view stops disagreeing with the function
-- =============================================================================
-- ops.fn_monthly_fresh_disc_tracker (the function /targets actually calls,
-- per 0037) already removed the automatic 6-item accessory exclusion,
-- replacing it with an optional p_subcategories[] the caller supplies.
-- ops.vw_monthly_fresh_disc_tracker (this view, last touched 0032) never
-- got the same fix — it still hardcodes
--   BOW CLIP, HAIR CLIP, HAIRBAND, SCRUNCHIE, NECKLACE, WAIST CHAIN
-- as an automatic exclusion from BOTH sums. Same store/month, two different
-- Fresh/Discounted splits depending which object is queried — this is the
-- divergence flagged in Objective.md's Open Decision #1.
--
-- Confirmed via full-repo trace: this view has ZERO live callers anywhere in
-- web/** today (only a generated TS type references its name — no runtime
-- query). So this migration carries no application-behavior risk; it exists
-- to remove the divergence at the source in case anything is ever pointed at
-- this view again, and so the two objects can never again silently disagree.
--
-- Per the user's explicit direction (2026-08-15): no hardcoded category/
-- subcategory exclusion rule anywhere — Fresh/Discounted inclusion is
-- entirely the caller's choice, same posture the function already has.
-- =============================================================================

create or replace view ops.vw_monthly_fresh_disc_tracker
with (security_invoker = on) as
with actual_daily as (
  select
    l.store_id,
    l.bill_date,
    sum(l.total_quantity) filter (
      where (l.gross_amount = 0 or (l.discount_amount / l.gross_amount) < 0.495)
    )                                                                as fresh_actual_qty,
    sum(l.total_quantity) filter (
      where l.gross_amount <> 0 and (l.discount_amount / l.gross_amount) >= 0.495
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
  'Spans every day of the target''s month, including future days (actual = 0). The app is responsible for only rendering rows up to today — this view does not know "today". Fresh/Discounted split (0023, tolerance 0025): Discounted = discount_amount/gross_amount >= 0.495, everything else (including gross_amount = 0) is Fresh. NO automatic subcategory/category exclusion (0055 — previously excluded 6 hardcoded accessory subcategories per 0027/0032, which had drifted out of sync with ops.fn_monthly_fresh_disc_tracker''s already-user-selectable behavior since 0037). This view currently has no live application caller — web/app/(ho)/targets/page.tsx uses ops.fn_monthly_fresh_disc_tracker instead — kept for any other future consumer, now with matching behavior.';

grant select on ops.vw_monthly_fresh_disc_tracker to authenticated;
