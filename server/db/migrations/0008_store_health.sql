-- =============================================================================
-- 0008 · Store health score (0-100), configuration-driven
-- =============================================================================
-- Section 10 of the brief asks for a score that is NOT hard-coded in the
-- frontend. Weights and normalization bounds live in a table an HO admin can
-- edit; ops.fn_compute_store_health() reads them at call time. Any factor
-- whose input metric is NULL (stock, until Phase 2) contributes zero weight
-- for that store rather than being silently scored as if it were bad —
-- the breakdown JSON says exactly which factors were skipped and why.

create table ops.health_score_factors (
  factor_key   text primary key,          -- 'sales_growth_wow' | 'target_achievement' | ...
  label        text not null,
  weight       numeric(4,3) not null check (weight between 0 and 1),
  good_value   numeric not null,          -- metric value that scores 100
  poor_value   numeric not null,          -- metric value that scores 0 (can be > good_value for inverse metrics)
  is_active    boolean not null default true
);

insert into ops.health_score_factors (factor_key, label, weight, good_value, poor_value) values
  ('sales_growth_wow',    'Sales growth, WOW',        0.25,  15,   -15),
  ('target_achievement',  'Target achievement %',     0.25, 100,    50),
  ('footfall_growth_wow', 'Footfall growth, WOW',     0.15,  15,   -15),
  ('conversion_pct',      'Conversion %',             0.15,  25,     5),
  ('atv_vs_network',      'ATV vs network avg',       0.10,  20,   -20),
  ('upt_vs_network',      'UPT vs network avg',       0.10,  20,   -20);
-- Two more factors from the brief — stock_availability, slow_stock_value — are
-- intentionally NOT inserted yet. Add them (and rebalance weights) once
-- Phase 2's stock SQL view lands; fn_compute_store_health already renormalizes
-- across whichever factors are_active and have non-null input, so this is a
-- data change, not a code change.

alter table ops.health_score_factors enable row level security;
create policy health_factors_read on ops.health_score_factors for select using (true);
create policy health_factors_write on ops.health_score_factors for all
  using (core.fn_user_role() in ('ho_admin', 'super_admin'))
  with check (core.fn_user_role() in ('ho_admin', 'super_admin'));

-- ---------------------------------------------------------------------------
-- Raw inputs, one row per store, for the trailing retail week vs the one before.
-- ---------------------------------------------------------------------------
create or replace view ops.vw_store_health_inputs
with (security_invoker = on) as
with weeks as (
  select store_id, week_start, net_sales,
         lag(net_sales) over (partition by store_id order by week_start)  as prev_net_sales
  from sales.vw_ebo_sales_weekly
  where is_complete_week
),
foot_weeks as (
  select store_id, date_trunc('week', date)::date as week_start,
         sum(footfall) as footfall,
         lag(sum(footfall)) over (partition by store_id order by date_trunc('week', date)::date) as prev_footfall
  from ops.ebo_footfall_daily
  group by store_id, date_trunc('week', date)
),
latest as (
  select store_id, max(week_start) as week_start from weeks group by store_id
),
network_avg as (
  select avg(atv) as avg_atv, avg(upt) as avg_upt
  from sales.vw_ebo_sales_weekly
  where is_complete_week
)
select
  w.store_id,
  w.week_start,
  case when w.prev_net_sales > 0 then round(100.0 * (w.net_sales - w.prev_net_sales) / w.prev_net_sales, 2) end as sales_growth_wow,
  ta.achievement_pct                                                                                            as target_achievement,
  case when fw.prev_footfall > 0 then round(100.0 * (fw.footfall - fw.prev_footfall) / fw.prev_footfall, 2) end as footfall_growth_wow,
  cd.conversion_pct,
  case when na.avg_atv > 0 then round(100.0 * (sw.atv - na.avg_atv) / na.avg_atv, 2) end                        as atv_vs_network,
  case when na.avg_upt > 0 then round(100.0 * (sw.upt - na.avg_upt) / na.avg_upt, 2) end                        as upt_vs_network
from weeks w
join latest l on l.store_id = w.store_id and l.week_start = w.week_start
join sales.vw_ebo_sales_weekly sw on sw.store_id = w.store_id and sw.week_start = w.week_start
left join foot_weeks fw on fw.store_id = w.store_id and fw.week_start = w.week_start
left join ops.vw_ebo_target_achievement ta on ta.store_id = w.store_id
cross join network_avg na
left join lateral (
  select round(avg(conversion_pct), 2) as conversion_pct
  from ops.vw_ebo_conversion_daily
  where store_id = w.store_id and week_start = w.week_start
) cd on true;

-- ---------------------------------------------------------------------------
-- Weighted, renormalized score. Returns the 0-100 score plus a breakdown so
-- the UI can show "why" (screen 01/02 in the mock), never just the number.
-- ---------------------------------------------------------------------------
create or replace function ops.fn_compute_store_health(p_store_id text)
returns table (score numeric, status text, breakdown jsonb)
language sql
stable
security invoker
as $$
  with inputs as (
    select * from ops.vw_store_health_inputs where store_id = p_store_id
  ),
  metric_values as (
    select 'sales_growth_wow'    as factor_key, sales_growth_wow    as value from inputs
    union all select 'target_achievement',  target_achievement  from inputs
    union all select 'footfall_growth_wow', footfall_growth_wow from inputs
    union all select 'conversion_pct',      conversion_pct      from inputs
    union all select 'atv_vs_network',      atv_vs_network      from inputs
    union all select 'upt_vs_network',      upt_vs_network      from inputs
  ),
  scored as (
    select
      f.factor_key, f.label, f.weight, mv.value,
      case
        when mv.value is null then null
        else greatest(0, least(100,
          100.0 * (mv.value - f.poor_value) / nullif(f.good_value - f.poor_value, 0)
        ))
      end as factor_score
    from ops.health_score_factors f
    left join metric_values mv using (factor_key)
    where f.is_active
  )
  select
    round(sum(factor_score * weight) / nullif(sum(weight) filter (where factor_score is not null), 0), 1) as score,
    case
      when sum(factor_score * weight) / nullif(sum(weight) filter (where factor_score is not null), 0) >= 70 then 'GREEN'
      when sum(factor_score * weight) / nullif(sum(weight) filter (where factor_score is not null), 0) >= 45 then 'AMBER'
      else 'RED'
    end as status,
    jsonb_agg(jsonb_build_object(
      'factor', factor_key, 'label', label, 'weight', weight,
      'raw_value', value, 'score', factor_score,
      'skipped', factor_score is null
    ) order by weight desc) as breakdown
  from scored;
$$;

comment on function ops.fn_compute_store_health is
  'Weights renormalize across only the factors that have data — a store missing conversion (no footfall entered yet) is scored on the remaining 5 factors, not penalized to zero. breakdown always lists every configured factor with skipped=true where it had no input, so the UI can show exactly why a factor was left out.';

grant select on ops.vw_store_health_inputs to authenticated;
grant execute on function ops.fn_compute_store_health(text) to authenticated;
