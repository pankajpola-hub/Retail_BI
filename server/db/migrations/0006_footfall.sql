-- =============================================================================
-- 0006 · Footfall (manual entry — confirmed no ERP source exists)
-- =============================================================================

create table ops.ebo_footfall_daily (
  id           uuid primary key default gen_random_uuid(),
  store_id     text not null references core.stores (store_id),
  date         date not null,
  footfall     integer not null check (footfall >= 0),
  source       text not null default 'manual' check (source in ('manual', 'erp', 'sensor')),
  remarks      text,
  entered_by   uuid references core.profiles (user_id),
  entered_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (store_id, date)
);

comment on column ops.ebo_footfall_daily.source is
  'Set to manual today. If Logic ERP or a door counter starts supplying footfall later, ingest it under source = erp/sensor into the same table — every downstream conversion view is unchanged.';

create trigger trg_footfall_touch_updated_at
  before update on ops.ebo_footfall_daily
  for each row execute function extensions.moddatetime(updated_at);
-- If the moddatetime extension isn't available in your project, replace with a
-- one-line BEFORE UPDATE trigger setting NEW.updated_at = now().

-- Footfall can never be lower than that day's sale-bill count — conversion
-- cannot exceed 100%. Checked against the real bill count, not user input.
create or replace function ops.fn_validate_footfall()
returns trigger
language plpgsql
security definer
set search_path = ops, sales, pg_temp
as $$
declare
  v_bills integer;
begin
  select coalesce(sale_bills, 0) into v_bills
  from sales.vw_ebo_sales_daily
  where store_id = new.store_id and bill_date = new.date;

  if new.footfall < coalesce(v_bills, 0) then
    raise exception 'Footfall (%) cannot be less than the day''s % sale bills for store % on %',
      new.footfall, v_bills, new.store_id, new.date;
  end if;
  return new;
end;
$$;

create trigger trg_footfall_validate
  before insert or update on ops.ebo_footfall_daily
  for each row execute function ops.fn_validate_footfall();

-- ---------------------------------------------------------------------------
-- Conversion view — the reason footfall exists. LEFT JOIN, not INNER: a day
-- with no footfall entry must show conversion as NULL, never as 0%.
-- ---------------------------------------------------------------------------
create or replace view ops.vw_ebo_conversion_daily
with (security_invoker = on) as
select
  d.store_id, d.bill_date, d.day_name, d.week_start, d.retail_week, d.retail_year,
  d.sale_bills, d.net_sales, d.atv, d.upt,
  f.footfall,
  case when f.footfall > 0
    then round(100.0 * d.sale_bills / f.footfall, 2)
  end                                                        as conversion_pct,
  case when f.footfall > 0
    then round(d.net_sales / f.footfall, 2)
  end                                                        as sales_per_footfall
from sales.vw_ebo_sales_daily d
left join ops.ebo_footfall_daily f on f.store_id = d.store_id and f.date = d.bill_date;

grant select on ops.vw_ebo_conversion_daily to authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table ops.ebo_footfall_daily enable row level security;

create policy footfall_read on ops.ebo_footfall_daily
  for select using (store_id = any (core.fn_user_store_ids()));

create policy footfall_write on ops.ebo_footfall_daily
  for insert with check (
    store_id = any (core.fn_user_store_ids())
    and core.fn_user_role() in ('ebo_manager', 'regional_manager', 'ho_admin', 'super_admin')
  );

create policy footfall_update on ops.ebo_footfall_daily
  for update using (
    store_id = any (core.fn_user_store_ids())
    and core.fn_user_role() in ('ebo_manager', 'regional_manager', 'ho_admin', 'super_admin')
    -- Backdating beyond 7 days needs HO approval — enforced here, not just in the UI.
    and (date >= current_date - 7 or core.fn_user_role() in ('ho_admin', 'super_admin'))
  );
