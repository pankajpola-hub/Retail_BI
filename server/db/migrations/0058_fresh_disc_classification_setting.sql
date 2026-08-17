-- =============================================================================
-- 0058 · Fresh/Discounted classification source becomes an admin setting
-- =============================================================================
-- Reads core.app_settings.fresh_disc_classification_source (0057) instead of
-- hardcoding the discount-ratio rule. Two branches:
--   'discount_ratio' (default — preserves today's live behavior exactly):
--     gross_amount = 0 or discount_amount/gross_amount < 0.495 -> Fresh,
--     else Discounted. Unchanged since 0025.
--   'scheme_lookup': Discounted iff raw_logic.scheme_lookup.is_discounted_50plus
--     is true for the line's item_code (barcode), else Fresh — the same
--     pattern already used for the Stock/EOSS split in
--     sales.vw_stock_with_scheme.is_eoss (0024), now available as an
--     alternative for the SALES Fresh/Discounted split too.
--
-- Both ops.fn_monthly_fresh_disc_tracker (what /targets calls) and
-- ops.vw_monthly_fresh_disc_audit_lines (the audit-report download) read the
-- SAME setting so they can never disagree — the exact "silent KPI drift"
-- failure mode Objective.md's Risks section warns about.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Audit lines: bucket + reason branch on the setting.
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
    when cfg.source = 'scheme_lookup' then
      case when coalesce(sl.is_discounted_50plus, false) then 'Discounted' else 'Fresh' end
    else
      case
        when l.gross_amount = 0 or (l.discount_amount / l.gross_amount) < 0.495
          then 'Fresh'
        else 'Discounted'
      end
  end as bucket,
  case
    when cfg.source = 'scheme_lookup' then
      case
        when sl.item_code is null
          then 'Fresh — barcode not in scheme master'
        when coalesce(sl.is_discounted_50plus, false)
          then 'Discounted — scheme master: ' || coalesce(sl.scheme_name, '(no scheme name on file)')
               || coalesce(', ' || round(sl.discount_pct, 1)::text || '% off', '')
        else 'Fresh — scheme master: ' || coalesce(sl.scheme_name, 'no scheme on file')
      end
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
left join sales.vw_item_subcategory_lookup sub on sub.item_code = l.item_code
left join raw_logic.scheme_lookup sl on sl.item_code = l.item_code
cross join (
  select coalesce(
    (select value ->> 'source' from core.app_settings where key = 'fresh_disc_classification_source'),
    'discount_ratio'
  ) as source
) cfg;

comment on view ops.vw_monthly_fresh_disc_audit_lines is
  'Line-level detail backing the /targets audit report download. bucket/reason (0058) branch on core.app_settings.fresh_disc_classification_source: discount_ratio (default, 0025''s 49.5%-of-gross rule, no subcategory exclusion per 0037) or scheme_lookup (raw_logic.scheme_lookup.is_discounted_50plus by item_code/barcode, same pattern as sales.vw_stock_with_scheme.is_eoss). Whether accessories are counted in a given tracker/report is entirely down to the caller''s Subcategory filter selection, not this view.';

grant select on ops.vw_monthly_fresh_disc_audit_lines to authenticated;

-- -----------------------------------------------------------------------------
-- Tracker RPC: same branch, applied inside the FILTER predicates.
-- -----------------------------------------------------------------------------
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
  cfg as (
    select coalesce(
      (select value ->> 'source' from core.app_settings where key = 'fresh_disc_classification_source'),
      'discount_ratio'
    ) as source
  ),
  actual_daily as (
    select
      l.store_id,
      l.bill_date,
      sum(l.total_quantity) filter (
        where (p_genders is null or cardinality(p_genders) = 0 or sub.gender = any (p_genders))
          and (p_subcategories is null or cardinality(p_subcategories) = 0 or sub.subcategory = any (p_subcategories))
          and (p_categories is null or cardinality(p_categories) = 0 or l.category = any (p_categories))
          and not (
            case when cfg.source = 'scheme_lookup'
              then coalesce(sl.is_discounted_50plus, false)
              else (l.gross_amount <> 0 and (l.discount_amount / l.gross_amount) >= 0.495)
            end
          )
      )                                                                as fresh_actual_qty,
      sum(l.total_quantity) filter (
        where (p_genders is null or cardinality(p_genders) = 0 or sub.gender = any (p_genders))
          and (p_subcategories is null or cardinality(p_subcategories) = 0 or sub.subcategory = any (p_subcategories))
          and (p_categories is null or cardinality(p_categories) = 0 or l.category = any (p_categories))
          and (
            case when cfg.source = 'scheme_lookup'
              then coalesce(sl.is_discounted_50plus, false)
              else (l.gross_amount <> 0 and (l.discount_amount / l.gross_amount) >= 0.495)
            end
          )
      )                                                                as discounted_actual_qty
    from sales.vw_ebo_sales_lines l
    left join sales.vw_item_subcategory_lookup sub on sub.item_code = l.item_code
    left join raw_logic.scheme_lookup sl on sl.item_code = l.item_code
    cross join cfg
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
  'Multi-select twin of ops.vw_monthly_fresh_disc_tracker with optional p_genders/p_subcategories/p_categories arrays (0037, NULL or empty = no filter on that dimension). No automatic accessory exclusion — accessories count unless the caller filters them out via p_subcategories. Classification source (0058) is core.app_settings.fresh_disc_classification_source: discount_ratio (default, 49.5%-of-gross) or scheme_lookup (raw_logic.scheme_lookup.is_discounted_50plus by barcode). fresh_target_qty/discounted_target_qty are never filtered — ops.ebo_monthly_targets has no gender/subcategory breakdown, so a filtered actual is compared against the whole-month target regardless of filter.';

revoke all on function ops.fn_monthly_fresh_disc_tracker(text, date, text[], text[], text[]) from public, anon;
grant execute on function ops.fn_monthly_fresh_disc_tracker(text, date, text[], text[], text[]) to authenticated;
