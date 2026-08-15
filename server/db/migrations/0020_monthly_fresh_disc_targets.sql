-- =============================================================================
-- 0020 · Monthly Fresh/Discounted qty tracker
-- =============================================================================
-- Mirrors the "P - Monthly Tracker" sheet EBO managers already keep by hand
-- (FSO - Pune Factory Outlet - NIBM - MTD.xlsx): a monthly unit-quantity
-- target split Fresh (full-price) vs Discounted (any scheme applied), with
-- daily MTD pacing computed against actual sales — not a second manually
-- typed number, the actual comes straight from sales.vw_ebo_sales_lines.
--
-- Distinct from ops.ebo_targets (0007): that one is a single monthly sales-
-- value target. This is unit quantity, split by Fresh/Discounted, because
-- that's the split the sheet — and the underlying scheme data — actually
-- supports. The two tables are independent; nothing here reads or writes
-- ops.ebo_targets.

create table ops.ebo_monthly_targets (
  id                     uuid primary key default gen_random_uuid(),
  store_id               text not null references core.stores (store_id),
  period_month           date not null,   -- first-of-month key, e.g. 2026-08-01
  fresh_target_qty       integer not null check (fresh_target_qty >= 0),
  discounted_target_qty  integer not null check (discounted_target_qty >= 0),
  set_by                 uuid references core.profiles (user_id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (store_id, period_month)
);

comment on column ops.ebo_monthly_targets.period_month is
  'Always the 1st of the month. The app truncates whatever month it collects to this before writing.';

create trigger trg_monthly_targets_touch_updated_at
  before update on ops.ebo_monthly_targets
  for each row execute function extensions.moddatetime(updated_at);

alter table ops.ebo_monthly_targets enable row level security;

-- Same shape as ops.ebo_targets (0007): everyone with store access can read,
-- only HO/super admin can set. "Once a month" from the product side is a UI
-- convention (the confirm-overwrite prompt), not a DB constraint — the
-- unique(store_id, period_month) + upsert is what actually enforces one row
-- per store per month; nothing stops a correction later in the month.
create policy monthly_targets_read on ops.ebo_monthly_targets
  for select using (store_id = any (core.fn_user_store_ids()));

create policy monthly_targets_write on ops.ebo_monthly_targets
  for insert with check (core.fn_user_role() in ('ho_admin', 'super_admin'));

create policy monthly_targets_update on ops.ebo_monthly_targets
  for update using (core.fn_user_role() in ('ho_admin', 'super_admin'));

grant select, insert, update on ops.ebo_monthly_targets to authenticated;

-- ---------------------------------------------------------------------------
-- Daily tracker: one row per (target, day-of-that-month), actual qty split
-- Fresh vs Discounted the same way the sheet's source data does — a line
-- with no scheme applied is Fresh, any scheme (Flat 50%, B1G1, etc) is
-- Discounted. total_quantity already nets returns (RB lines carry negative
-- quantity in the raw feed), so no separate return handling is needed.
-- ---------------------------------------------------------------------------
create or replace view ops.vw_monthly_fresh_disc_tracker
with (security_invoker = on) as
with actual_daily as (
  select
    store_id,
    bill_date,
    sum(total_quantity) filter (where scheme_group_name is null)     as fresh_actual_qty,
    sum(total_quantity) filter (where scheme_group_name is not null) as discounted_actual_qty
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
  'Spans every day of the target''s month, including future days (actual = 0). The app is responsible for only rendering rows up to today — this view does not know "today".';

grant select on ops.vw_monthly_fresh_disc_tracker to authenticated;
