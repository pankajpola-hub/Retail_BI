-- =============================================================================
-- 0019 · Footfall audit trail + data completeness
-- =============================================================================
-- Supports the Footfall & Traffic Intelligence module:
--   * audit columns so HO can see who entered what and when (spec §3)
--   * a completeness view so conversion is never trusted blindly when
--     footfall is missing for a store-day (spec §4, §37)

-- updated_by complements the existing entered_by/entered_at/updated_at:
-- an edit by a regional manager to a store manager's entry must be
-- attributable to the editor, not silently credited to the original author.
alter table ops.ebo_footfall_daily
  add column if not exists updated_by uuid references core.profiles (user_id);

-- ---------------------------------------------------------------------------
-- Completeness: one row per store x day in range, flagging whether footfall
-- was entered. Deliberately built off the same store x calendar spine as
-- sales.vw_ebo_sales_daily so "expected store-days" means the same thing in
-- both places — a day the store existed, up to today.
-- ---------------------------------------------------------------------------
create or replace view ops.vw_footfall_completeness
with (security_invoker = on) as
select
  s.store_id,
  rc.date,
  (f.footfall is not null)          as has_footfall,
  f.footfall,
  f.entered_at,
  f.remarks
from core.stores s
join core.retail_calendar rc
  on rc.date between coalesce(s.opened_date, rc.date) and current_date
left join ops.ebo_footfall_daily f
  on f.store_id = s.store_id and f.date = rc.date
where s.is_active
  and s.store_id = any (core.fn_user_store_ids());

comment on view ops.vw_footfall_completeness is
  'One row per active store per day up to today, with has_footfall telling you whether an entry exists. The denominator for the "Footfall data completeness %" KPI — a low value means conversion figures for the period are computed on partial traffic data and should not be read as reliable.';

grant select on ops.vw_footfall_completeness to authenticated;

-- ---------------------------------------------------------------------------
-- Per-store recent footfall stats, for the "unusually high/low" warning on
-- entry (spec §3) and the consistency metrics (spec §25). Trailing 28 days,
-- entered values only — a store with no history yet returns no row, and the
-- app must treat that as "no basis to warn", not as "value is fine".
-- ---------------------------------------------------------------------------
create or replace view ops.vw_footfall_stats
with (security_invoker = on) as
select
  store_id,
  count(*)                                              as days_recorded,
  round(avg(footfall)::numeric, 1)                      as avg_footfall,
  min(footfall)                                          as min_footfall,
  max(footfall)                                          as max_footfall,
  round(stddev_samp(footfall)::numeric, 2)              as stddev_footfall,
  case when avg(footfall) > 0
    then round((stddev_samp(footfall) / avg(footfall) * 100)::numeric, 1)
  end                                                    as coeff_variation_pct
from ops.ebo_footfall_daily
where date >= current_date - 28
group by store_id;

comment on view ops.vw_footfall_stats is
  'Trailing 28-day footfall distribution per store. coeff_variation_pct (stddev/mean) flags unstable traffic. Used for the outlier warning on manual entry — warn, never auto-reject, since legitimate spikes (festival, campaign, local event) are exactly the days that matter most.';

grant select on ops.vw_footfall_stats to authenticated;
