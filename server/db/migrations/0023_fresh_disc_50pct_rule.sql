-- =============================================================================
-- 0023 · Fresh/Discounted reclassified by a 50%-off threshold, not scheme presence
-- =============================================================================
-- ops.vw_monthly_fresh_disc_tracker (0020) originally bucketed a line as
-- Discounted purely on whether it carried ANY scheme_group_name at all —
-- discount depth never entered into it, so a line with a 5% scheme discount
-- and a line with an 80% scheme discount landed in the same "Discounted"
-- bucket, while a full-price line with no scheme was "Fresh" regardless of
-- its actual discount_amount.
--
-- New rule, business-requested: a line is Discounted only when its discount
-- is 50% or more of gross (discount_amount / gross_amount >= 0.5). Everything
-- else — 0-49% off, including full-price and small markdowns — is Fresh.
-- scheme_group_name is no longer consulted for this split at all.
--
-- Edge case: gross_amount = 0 (free/zero-value line) would divide by zero;
-- treated as 0% discount, i.e. Fresh, rather than erroring or going to NULL.
--
-- Only the actual_daily CTE inside the tracker view changes. Every other
-- column, the spine/pacing logic, and the view's output shape are untouched,
-- so web/app/(ho)/targets/page.tsx's TrackerRow type still matches exactly.
-- =============================================================================

create or replace view ops.vw_monthly_fresh_disc_tracker
with (security_invoker = on) as
with actual_daily as (
  select
    store_id,
    bill_date,
    sum(total_quantity) filter (
      where gross_amount = 0 or (discount_amount / gross_amount) < 0.5
    )                                                                as fresh_actual_qty,
    sum(total_quantity) filter (
      where gross_amount <> 0 and (discount_amount / gross_amount) >= 0.5
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
  'Spans every day of the target''s month, including future days (actual = 0). The app is responsible for only rendering rows up to today — this view does not know "today". Fresh/Discounted split (0023): Discounted = discount_amount/gross_amount >= 0.5, everything else (including gross_amount = 0) is Fresh. No longer based on scheme_group_name presence.';

grant select on ops.vw_monthly_fresh_disc_tracker to authenticated;
