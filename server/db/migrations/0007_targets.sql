-- =============================================================================
-- 0007 · Targets, achievement, run rate
-- =============================================================================

create table ops.ebo_targets (
  id                uuid primary key default gen_random_uuid(),
  store_id          text not null references core.stores (store_id),
  period_month      date not null,              -- first-of-month key, e.g. 2026-08-01
  target_sales      numeric(14,2) not null check (target_sales >= 0),
  target_bills      integer,
  target_footfall   integer,
  target_conversion numeric(5,2),
  target_atv        numeric(10,2),
  target_upt        numeric(6,3),
  set_by            uuid references core.profiles (user_id),
  created_at        timestamptz not null default now(),
  unique (store_id, period_month)
);

alter table ops.ebo_targets enable row level security;

create policy targets_read on ops.ebo_targets
  for select using (store_id = any (core.fn_user_store_ids()));

create policy targets_write on ops.ebo_targets
  for insert with check (core.fn_user_role() in ('ho_admin', 'super_admin'));

create policy targets_update on ops.ebo_targets
  for update using (core.fn_user_role() in ('ho_admin', 'super_admin'));

-- ---------------------------------------------------------------------------
-- Achievement, gap, required daily run rate for the month-to-date.
-- ---------------------------------------------------------------------------
create or replace view ops.vw_ebo_target_achievement
with (security_invoker = on) as
with mtd as (
  select
    store_id,
    date_trunc('month', bill_date)::date as period_month,
    sum(net_sales)                       as mtd_sales,
    max(bill_date)                       as last_data_date
  from sales.vw_ebo_sales_daily
  where bill_date >= date_trunc('month', current_date)
  group by store_id, date_trunc('month', bill_date)
)
select
  t.store_id, t.period_month,
  t.target_sales,
  coalesce(m.mtd_sales, 0)                                              as actual_sales_mtd,
  t.target_sales - coalesce(m.mtd_sales, 0)                             as target_gap,
  round(100.0 * coalesce(m.mtd_sales, 0) / nullif(t.target_sales, 0), 2) as achievement_pct,
  (t.period_month + interval '1 month' - interval '1 day')::date        as period_end,
  greatest((t.period_month + interval '1 month' - interval '1 day')::date - current_date, 0)::int + 1
                                                                          as days_remaining,
  round(
    (t.target_sales - coalesce(m.mtd_sales, 0))
      / nullif(
          greatest((t.period_month + interval '1 month' - interval '1 day')::date - current_date, 0) + 1
        , 0)
  , 2)                                                                  as required_daily_run_rate,
  round(
    coalesce(m.mtd_sales, 0) / nullif(extract(day from current_date)::int, 0)
  , 2)                                                                  as current_daily_run_rate
from ops.ebo_targets t
left join mtd m on m.store_id = t.store_id and m.period_month = t.period_month
where t.store_id = any (core.fn_user_store_ids())
  and t.period_month = date_trunc('month', current_date)::date;

grant select on ops.vw_ebo_target_achievement to authenticated;
