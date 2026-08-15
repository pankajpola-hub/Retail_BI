-- =============================================================================
-- 0009 · Diagnosis engine & opportunity / action queue
-- =============================================================================

-- Phase 2 stub: an empty table today so the diagnosis function below can LEFT
-- JOIN it without conditional code. Populate once a stock SQL view exists.
create table ops.stock_availability_snapshot (
  store_id      text not null references core.stores (store_id),
  as_of_date    date not null,
  availability_pct numeric(5,2),
  primary key (store_id, as_of_date)
);
alter table ops.stock_availability_snapshot enable row level security;
create policy stock_snapshot_read on ops.stock_availability_snapshot
  for select using (store_id = any (core.fn_user_store_ids()));

-- ---------------------------------------------------------------------------
-- Diagnosis function — one retail week vs the prior retail week.
-- Encodes scenarios A-D from the brief, and refuses to pick between LOW_FOOTFALL
-- and CONVERSION_ISSUE when footfall data doesn't exist for the store/week,
-- matching the "cannot check" behaviour in the store-diagnosis screen mock.
-- ---------------------------------------------------------------------------
create or replace function ops.fn_diagnose_store(p_store_id text, p_week_start date default null)
returns table (
  week_start          date,
  diagnosis_code      text,
  diagnosis_label     text,
  recommendation      text,
  confidence          text,       -- 'HIGH' | 'MEDIUM' | 'INSUFFICIENT_DATA'
  evidence            jsonb
)
language plpgsql
stable
security invoker
as $$
declare
  v_week date := coalesce(p_week_start, (select max(week_start) from sales.vw_ebo_sales_weekly where store_id = p_store_id and is_complete_week));
  v_sales_growth numeric;
  v_footfall_growth numeric;
  v_conversion_now numeric;
  v_conversion_prev numeric;
  v_atv_growth numeric;
  v_stock_pct numeric;
  v_has_footfall boolean;
begin
  select
    round(100.0 * (cur.net_sales - prev.net_sales) / nullif(prev.net_sales, 0), 2),
    round(100.0 * (cur.atv - prev.atv) / nullif(prev.atv, 0), 2)
  into v_sales_growth, v_atv_growth
  from sales.vw_ebo_sales_weekly cur
  join sales.vw_ebo_sales_weekly prev
    on prev.store_id = cur.store_id and prev.week_start = cur.week_start - 7
  where cur.store_id = p_store_id and cur.week_start = v_week;

  select
    (fw.footfall is not null and pw.footfall is not null),
    round(100.0 * (fw.footfall - pw.footfall) / nullif(pw.footfall, 0), 2),
    round(avg(cd.conversion_pct), 2),
    round(avg(pcd.conversion_pct), 2)
  into v_has_footfall, v_footfall_growth, v_conversion_now, v_conversion_prev
  from (select store_id, sum(footfall) as footfall from ops.ebo_footfall_daily
        where store_id = p_store_id and date >= v_week and date < v_week + 7 group by store_id) fw
  full outer join (select store_id, sum(footfall) as footfall from ops.ebo_footfall_daily
        where store_id = p_store_id and date >= v_week - 7 and date < v_week group by store_id) pw
    on true
  left join ops.vw_ebo_conversion_daily cd on cd.store_id = p_store_id and cd.week_start = v_week
  left join ops.vw_ebo_conversion_daily pcd on pcd.store_id = p_store_id and pcd.week_start = v_week - 7;

  select availability_pct into v_stock_pct
  from ops.stock_availability_snapshot
  where store_id = p_store_id and as_of_date <= v_week + 6
  order by as_of_date desc limit 1;

  week_start := v_week;
  evidence := jsonb_build_object(
    'sales_growth_wow', v_sales_growth,
    'footfall_growth_wow', v_footfall_growth,
    'conversion_now', v_conversion_now,
    'conversion_prev', v_conversion_prev,
    'atv_growth_wow', v_atv_growth,
    'stock_availability_pct', v_stock_pct,
    'footfall_data_available', v_has_footfall
  );

  -- Healthy growth first — a positive result should never be shadowed by a
  -- lower-priority negative branch.
  if v_sales_growth > 0 and coalesce(v_footfall_growth, 0) > 0
     and v_conversion_now >= coalesce(v_conversion_prev, v_conversion_now) and v_atv_growth > 0 then
    diagnosis_code := 'HEALTHY_GROWTH';
    diagnosis_label := 'Healthy growth across the board';
    recommendation := 'STUDY_AND_REPLICATE';
    confidence := 'HIGH';
    return next; return;
  end if;

  if v_sales_growth < 0 then
    if not v_has_footfall then
      diagnosis_code := 'INSUFFICIENT_DATA';
      diagnosis_label := 'Sales down — cannot separate footfall from conversion without footfall data';
      recommendation := 'START_FOOTFALL_ENTRY';
      confidence := 'INSUFFICIENT_DATA';
      return next; return;
    end if;

    if v_stock_pct is not null and v_stock_pct < 80 then
      diagnosis_code := 'STOCK_ISSUE';
      diagnosis_label := 'Sales down with weak stock availability';
      recommendation := 'FIX_STOCK_FIRST';   -- never recommend marketing spend while stock is the constraint
      confidence := 'HIGH';
    elsif v_footfall_growth < -5 and abs(coalesce(v_conversion_now,0) - coalesce(v_conversion_prev,0)) <= 1 then
      diagnosis_code := 'LOW_FOOTFALL';
      diagnosis_label := 'Sales down, driven by falling footfall';
      recommendation := 'MARKETING_SUPPORT';
      confidence := 'MEDIUM';
    elsif v_footfall_growth >= 0 and v_conversion_now < coalesce(v_conversion_prev, v_conversion_now) then
      diagnosis_code := 'CONVERSION_ISSUE';
      diagnosis_label := 'Sales down despite stable or rising footfall — conversion fell';
      recommendation := 'STORE_OPS_REVIEW';
      confidence := 'MEDIUM';
    else
      diagnosis_code := 'MIXED_SIGNAL';
      diagnosis_label := 'Sales down, footfall and conversion moved together — needs a manual look';
      recommendation := 'REGIONAL_MANAGER_REVIEW';
      confidence := 'MEDIUM';
    end if;
    return next; return;
  end if;

  diagnosis_code := 'STABLE';
  diagnosis_label := 'No significant movement this week';
  recommendation := 'NONE';
  confidence := 'MEDIUM';
  return next;
end;
$$;

grant execute on function ops.fn_diagnose_store(text, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Action / opportunity queue
-- ---------------------------------------------------------------------------
create type ops.opportunity_type as enum (
  'marketing', 'conversion', 'atv', 'upt', 'stock', 'product', 'slow_stock', 'target_gap', 'data_quality'
);
create type ops.action_priority as enum ('P1', 'P2', 'P3');
create type ops.action_status as enum (
  'recommended', 'requested', 'approved', 'rejected', 'in_progress', 'completed', 'result_measured'
);

create table ops.action_items (
  id                    uuid primary key default gen_random_uuid(),
  store_id              text references core.stores (store_id),   -- null = network-wide (e.g. "turn on footfall entry")
  opportunity_type      ops.opportunity_type not null,
  priority               ops.action_priority not null,
  problem_statement      text not null,
  evidence                jsonb not null default '{}'::jsonb,
  opportunity_size_inr    numeric(14,2),
  recommended_action      text not null,
  owner_role              core.app_role not null,
  owner_user_id           uuid references core.profiles (user_id),
  status                  ops.action_status not null default 'recommended',
  result_metric           text,             -- e.g. 'net_sales', matched against the metric that opened the action
  result_before           numeric,
  result_after            numeric,
  result_measured_at      timestamptz,
  created_at              timestamptz not null default now(),
  resolved_at             timestamptz
);

comment on column ops.action_items.result_metric is
  'Closing an action without setting result_before/result_after is allowed but leaves it queryable as "closed, unmeasured" — see ops.vw_action_queue_summary.';

create index idx_action_items_store_status on ops.action_items (store_id, status);

alter table ops.action_items enable row level security;

create policy action_items_read on ops.action_items
  for select using (store_id is null or store_id = any (core.fn_user_store_ids()));

create policy action_items_insert on ops.action_items
  for insert with check (
    (store_id is null or store_id = any (core.fn_user_store_ids()))
    and (
      core.fn_user_role() in ('ho_admin', 'regional_manager', 'marketing', 'super_admin')
      or (core.fn_user_role() = 'ebo_manager' and opportunity_type = 'marketing')
    )
  );

create policy action_items_update on ops.action_items
  for update using (
    (store_id is null or store_id = any (core.fn_user_store_ids()))
    and core.fn_user_role() in ('ho_admin', 'regional_manager', 'marketing', 'super_admin')
  );

create or replace view ops.vw_action_queue_summary
with (security_invoker = on) as
select
  count(*) filter (where status not in ('completed', 'result_measured', 'rejected'))       as open_count,
  count(*) filter (where status = 'completed' and result_measured_at is null)              as closed_unmeasured_count,
  count(*) filter (where status = 'result_measured')                                       as measured_count
from ops.action_items;

grant select on ops.vw_action_queue_summary to authenticated;
