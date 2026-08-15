-- =============================================================================
-- 0037 · Targets filters: multi-select, and accessories are a user choice
-- =============================================================================
-- Two changes to how /targets' Gender / Subcategory / Category filters work,
-- both from direct user feedback (2026-08-12):
--   1. Every filter becomes multi-select (pick several genders/subcategories/
--      categories at once), not one-at-a-time.
--   2. The automatic "always exclude accessory subcategories from the
--      Fresh/Discounted totals" rule (0027/0029/0032) is removed entirely.
--      Whether accessories count is now purely up to what the user selects
--      in the Subcategory filter — no filter selected = everything counts,
--      accessories included. The app no longer makes this call for the user.

-- -----------------------------------------------------------------------------
-- Subcategory option list: stop hiding accessory subcategories. They're real,
-- selectable options now, same as any other subcategory.
-- -----------------------------------------------------------------------------
create or replace view sales.vw_item_subcategory_options
with (security_invoker = on) as
select distinct subcategory
from sales.vw_item_subcategory_lookup
where subcategory is not null
order by subcategory;

grant select on sales.vw_item_subcategory_options to authenticated;

-- -----------------------------------------------------------------------------
-- Audit lines: drop the "Excluded - Accessory" special case. Every line gets
-- classified Fresh/Discounted by the same 49.5%-of-gross rule regardless of
-- subcategory — accessory or not, the line-level math doesn't change; only
-- whether a given audit-report/tracker QUERY chooses to include it (via the
-- Subcategory filter) changes.
-- -----------------------------------------------------------------------------
create or replace view ops.vw_monthly_fresh_disc_audit_lines
with (security_invoker = on) as
select
  l.line_id,
  l.store_id,
  l.bill_date,
  l.bill_no,
  l.bill_type,
  l.item_code,
  sub.subcategory,
  sub.gender,
  l.total_quantity,
  l.gross_amount,
  l.net_amount,
  l.discount_amount,
  l.scheme_name,
  l.scheme_group_name,
  round(100.0 * l.discount_amount / nullif(l.gross_amount, 0), 2) as discount_pct,
  case
    when l.gross_amount = 0 or (l.discount_amount / l.gross_amount) < 0.495
      then 'Fresh'
    else 'Discounted'
  end as bucket,
  case
    when l.gross_amount = 0
      then 'Fresh — zero gross amount, treated as 0% discount'
    when (l.discount_amount / l.gross_amount) < 0.495 and l.scheme_name is null
      then 'Fresh — no scheme'
    when (l.discount_amount / l.gross_amount) < 0.495
      then 'Fresh — scheme ' || l.scheme_name || ' only '
           || round(100.0 * l.discount_amount / l.gross_amount, 1)::text || '% off'
    else 'Discounted — ' || coalesce(l.scheme_name, '(no scheme name on file)') || ', '
         || round(100.0 * l.discount_amount / l.gross_amount, 1)::text || '% off'
  end as reason,
  l.category
from sales.vw_ebo_sales_lines l
left join sales.vw_item_subcategory_lookup sub on sub.item_code = l.item_code;

comment on view ops.vw_monthly_fresh_disc_audit_lines is
  'Line-level detail backing the /targets audit report download. bucket is the plain 49.5%-of-gross Fresh/Discounted split with NO subcategory exclusion (0037) — every line gets classified the same way regardless of subcategory; whether accessories are counted in a given tracker/report is entirely down to the caller''s Subcategory filter selection, not this view.';

grant select on ops.vw_monthly_fresh_disc_audit_lines to authenticated;

-- -----------------------------------------------------------------------------
-- Tracker RPC: array params, no automatic accessory exclusion.
-- -----------------------------------------------------------------------------
-- Signature changes (text -> text[]), so the old function must be dropped
-- first — CREATE OR REPLACE cannot change parameter types.
drop function if exists ops.fn_monthly_fresh_disc_tracker(text, date, text, text, text);

create or replace function ops.fn_monthly_fresh_disc_tracker(
  p_store_id text,
  p_period_month date,
  p_genders text[] default null,
  p_subcategories text[] default null,
  p_categories text[] default null
)
returns table(
  target_id uuid, store_id text, period_month date, date date, day_name text,
  day_of_month integer, days_in_month integer, fresh_target_qty integer,
  discounted_target_qty integer, fresh_actual_qty numeric, discounted_actual_qty numeric,
  fresh_cum_qty numeric, discounted_cum_qty numeric, fresh_mtd_target numeric,
  discounted_mtd_target numeric
)
language sql
set search_path to 'core', 'sales', 'ops', 'extensions', 'pg_temp'
as $$
  with params as (
    select
      btrim(p_store_id)                          as store_id,
      date_trunc('month', p_period_month)::date   as period_month
  ),
  actual_daily as (
    select
      l.store_id,
      l.bill_date,
      sum(l.total_quantity) filter (
        where (p_genders is null or cardinality(p_genders) = 0 or sub.gender = any (p_genders))
          and (p_subcategories is null or cardinality(p_subcategories) = 0 or sub.subcategory = any (p_subcategories))
          and (p_categories is null or cardinality(p_categories) = 0 or l.category = any (p_categories))
          and (l.gross_amount = 0 or (l.discount_amount / l.gross_amount) < 0.495)
      )                                                                as fresh_actual_qty,
      sum(l.total_quantity) filter (
        where (p_genders is null or cardinality(p_genders) = 0 or sub.gender = any (p_genders))
          and (p_subcategories is null or cardinality(p_subcategories) = 0 or sub.subcategory = any (p_subcategories))
          and (p_categories is null or cardinality(p_categories) = 0 or l.category = any (p_categories))
          and l.gross_amount <> 0 and (l.discount_amount / l.gross_amount) >= 0.495
      )                                                                as discounted_actual_qty
    from sales.vw_ebo_sales_lines l
    left join sales.vw_item_subcategory_lookup sub on sub.item_code = l.item_code
    where l.store_id = (select store_id from params)
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
    where t.store_id = (select store_id from params)
      and t.period_month = (select period_month from params)
      and t.store_id = any (core.fn_user_store_ids())
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
  order by sp.date;
$$;

comment on function ops.fn_monthly_fresh_disc_tracker is
  'Multi-select twin of ops.vw_monthly_fresh_disc_tracker (0020/0023/0025/0027) with optional p_genders/p_subcategories/p_categories arrays (0037, NULL or empty = no filter on that dimension). No automatic accessory exclusion (removed in 0037) — accessories count unless the caller filters them out via p_subcategories. fresh_target_qty/discounted_target_qty are never filtered — ops.ebo_monthly_targets has no gender/subcategory breakdown, so a filtered actual is compared against the whole-month target regardless of filter.';

revoke all on function ops.fn_monthly_fresh_disc_tracker(text, date, text[], text[], text[]) from public, anon;
grant execute on function ops.fn_monthly_fresh_disc_tracker(text, date, text[], text[], text[]) to authenticated;
