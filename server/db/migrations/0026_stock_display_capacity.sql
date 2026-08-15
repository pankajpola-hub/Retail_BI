-- =============================================================================
-- 0026 · Stock Details — admin-editable base display capacity
-- =============================================================================
-- The Stock Details page's "DC" (Display Capacity) planning matrix (4 blocks
-- per store: Girls Kids / Boys Kids / Girls Baby / Boys Baby, each split
-- 35% Fresh / 65% EOSS with a 110% buffer multiplier) needs a base capacity
-- number per store per gender x age-segment. Before this migration that
-- number did not exist anywhere — lib/stockDetails/aggregate.ts's DC matrix
-- is built entirely from live sales.vw_stock_with_scheme rows (an ACTUAL
-- Fresh/EOSS stock split), and the page explicitly disclaims the 35/65 plan
-- ("not a planned 35/65 split"). This table is what makes that planned split
-- real: 4 rows per store, one per (gender, age_segment).
--
-- Same shape as ops.ebo_monthly_targets (0020): unique(store_id, gender,
-- age_segment) + upsert from the app is what enforces one row per
-- combination, updated_by/updated_at is the audit trail the page shows to
-- every viewer regardless of role, and the moddatetime trigger keeps
-- updated_at honest on every UPDATE the same way 0020 does.
--
-- RLS differs from 0020 on purpose: 0020's read policy scopes by
-- store_id = any(core.fn_user_store_ids()) because ebo_monthly_targets is
-- operational per-store data. Base display capacity is closer to
-- ops.health_score_factors (0008) — small reference/config data every
-- HO-facing role should be able to see regardless of store grants — so the
-- read policy here is the same `using (true)` 0008 uses, open to the
-- `authenticated` role. Writes stay restricted to ho_admin/super_admin,
-- checked both here (RLS) and again in the Server Action that calls this
-- table (app/(stock-details)/stock-details/actions.ts), matching the
-- defense-in-depth pattern in app/(admin)/users/actions.ts.

create table ops.stock_display_capacity (
  id             uuid primary key default gen_random_uuid(),
  store_id       text not null references core.stores (store_id),
  gender         text not null check (gender in ('FEMALE', 'MALE')),
  age_segment    text not null check (age_segment in ('Baby', 'Kids')),
  base_capacity  integer not null check (base_capacity >= 0),
  updated_by     uuid references core.profiles (user_id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (store_id, gender, age_segment)
);

comment on table ops.stock_display_capacity is
  'Admin-set base display capacity per store x gender x age-segment (4 rows/store). Feeds lib/stockDetails/aggregate.ts''s buildCapacityPlan(): buffered = base * 1.10, fresh = buffered * 0.35, eoss = buffered * 0.65.';

create trigger trg_stock_display_capacity_touch_updated_at
  before update on ops.stock_display_capacity
  for each row execute function extensions.moddatetime(updated_at);

alter table ops.stock_display_capacity enable row level security;

-- Open read — every role that can reach the Stock Details page should see
-- the current capacity numbers and who last touched them, same reasoning as
-- ops.health_score_factors (0008).
create policy stock_display_capacity_read on ops.stock_display_capacity
  for select using (true);

create policy stock_display_capacity_insert on ops.stock_display_capacity
  for insert with check (core.fn_user_role() in ('ho_admin', 'super_admin'));

create policy stock_display_capacity_update on ops.stock_display_capacity
  for update using (core.fn_user_role() in ('ho_admin', 'super_admin'));

grant select, insert, update on ops.stock_display_capacity to authenticated;
