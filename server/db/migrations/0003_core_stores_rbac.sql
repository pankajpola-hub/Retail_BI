-- =============================================================================
-- 0003 · Store master & RBAC
-- =============================================================================

create table core.stores (
  store_id        text primary key,             -- 'BO-001' — short code used everywhere in the app
  branch_name_erp text not null unique,          -- exact Logic branch_name string, e.g. 'BO-001 - PUNE - UNDRI'
  store_name      text not null,                 -- 'Pune Undri'
  city            text not null,
  region          text not null,
  store_type      text not null default 'EBO',   -- EBO | FOFO | LFS | ONLINE — keep non-EBO channels out of BO-% by convention
  opened_date     date,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now()
);

comment on column core.stores.branch_name_erp is
  'Must match raw_logic branch_name exactly. Only rows whose branch_name starts with an onboarded store''s prefix are pulled into sales.vw_ebo_sales_lines — this is the control that keeps WAREHOUSE-* and OFFICE-* channels out of store performance data.';

-- opened_date left NULL — not present in the sample sales extract; backfill
-- once known, it only affects how far back sales.vw_ebo_sales_daily's spine
-- extends for these stores (see 0005_sales_rollup_views.sql).
insert into core.stores (store_id, branch_name_erp, store_name, city, region, opened_date) values
  ('BO-001', 'BO-001 - PUNE - UNDRI',        'Undri',        'Pune', 'West', null),
  ('BO-003', 'BO-003 - PUNE - SINHGAD ROAD', 'Sinhgad Road', 'Pune', 'West', null);

-- ---------------------------------------------------------------------------
-- RBAC
-- ---------------------------------------------------------------------------
-- Self-hosted replacement for Supabase's auth.uid(): the custom API verifies
-- the caller's Keycloak-issued JWT, then runs `SET LOCAL app.user_id = '<sub
-- claim>'` before every query in that request's transaction. This function
-- reads that back — same role in the RLS policies below as auth.uid() played
-- originally, just sourced from a session GUC instead of a Supabase-managed
-- JWT claim. `true` as the second arg to current_setting means "return NULL
-- instead of erroring if unset" — matching auth.uid()'s behavior of
-- returning NULL for a connection with no authenticated user.
create or replace function core.current_user_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('app.user_id', true), '')::uuid;
$$;

create type core.app_role as enum ('super_admin', 'ho_admin', 'regional_manager', 'ebo_manager', 'marketing');

-- No FK to a local users table — Keycloak (realm "ebo") is the source of
-- truth for identity, not Postgres. user_id here is the Keycloak user's
-- `sub` claim (a UUID). A row with no matching Keycloak user is inert (it
-- just never matches a current_user_id() value), not a referential-integrity
-- problem — the API is responsible for not creating orphaned profile rows.
create table core.profiles (
  user_id     uuid primary key,
  full_name   text not null,
  role        core.app_role not null,
  region      text,                              -- populated for regional_manager
  created_at  timestamptz not null default now()
);

-- One row per (user, store) grant. A regional_manager gets one row per store in
-- their region (kept explicit rather than derived from core.profiles.region so
-- a manager covering stores across two regions is representable without a schema change).
create table core.user_store_access (
  user_id   uuid not null references core.profiles (user_id) on delete cascade,
  store_id  text not null references core.stores (store_id) on delete cascade,
  primary key (user_id, store_id)
);

-- Central "what stores can this caller see" function — every store-scoped view
-- and RLS policy in this schema calls this instead of re-deriving the logic.
create or replace function core.fn_user_store_ids()
returns text[]
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select case
    when (select role from core.profiles where user_id = core.current_user_id()) in ('super_admin', 'ho_admin')
      then (select array_agg(store_id) from core.stores)
    else
      (select array_agg(store_id) from core.user_store_access where user_id = core.current_user_id())
  end;
$$;

create or replace function core.fn_user_role()
returns core.app_role
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select role from core.profiles where user_id = core.current_user_id();
$$;

alter table core.profiles enable row level security;
alter table core.user_store_access enable row level security;

create policy profiles_self_read on core.profiles
  for select using (user_id = core.current_user_id() or core.fn_user_role() in ('super_admin', 'ho_admin'));

create policy user_store_access_self_read on core.user_store_access
  for select using (user_id = core.current_user_id() or core.fn_user_role() in ('super_admin', 'ho_admin'));

-- Only super_admin manages roles/grants — done via service-role in an admin
-- screen, never by end-user INSERT, so no authenticated-role write policy exists.
