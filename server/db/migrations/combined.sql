-- ===== 0000_bootstrap_roles.sql =====
-- =============================================================================
-- 0000 · Bootstrap roles — self-hosted only, not part of the Supabase set
-- =============================================================================
-- On Supabase, `anon` and `authenticated` are platform-provisioned Postgres
-- roles that PostgREST connects as depending on whether a request carries a
-- valid JWT. Every migration ported from supabase/migrations/ grants access
-- to `authenticated` (15 files) — rather than rewrite all of them, this
-- migration recreates the same two roles here, and the custom Node API
-- connects AS `authenticated` for every request that has a verified Keycloak
-- JWT, setting `app.user_id` via SET LOCAL before running the actual query
-- (see core.current_user_id() in 0003). This is a faithful port of the same
-- security model: the connecting Postgres role is identical for every user,
-- and RLS is what actually scopes access per-user, exactly as it did with
-- PostgREST.
--
-- `anon` only needs to exist so the `revoke all on schema raw_logic from
-- anon, authenticated` style statements don't error — nothing in the custom
-- API ever actually connects as anon (there's no equivalent of an
-- unauthenticated PostgREST request; endpoints that don't need a login
-- don't touch the database as this role at all).

-- `authenticated` needs LOGIN to exist as a role Postgres will accept SET
-- ROLE into, but nothing ever connects directly AS authenticated with a
-- password — the Node API talks to PostgREST over HTTP with a Keycloak JWT,
-- and PostgREST's `authenticator` role does SET ROLE authenticated per
-- request, which only needs role membership, never this password. Treat it
-- as inert; rotate on the server with `ALTER ROLE authenticated WITH
-- PASSWORD '...'` if it's ever regenerated — this file's value does not
-- need to match live for anything to work.
create role anon nologin;
create role authenticated login password 'CHANGE_ME_this_password_is_never_actually_used';

-- ===== 0001_schemas_extensions.sql =====
-- =============================================================================
-- 0001 · Schemas & extensions
-- =============================================================================
-- Layout:
--   raw_logic   : Airbyte-landed Logic ERP tables. Never queried by the app directly.
--   core        : master data — stores, retail calendar, RBAC.
--   sales       : analytical views/materialized views built on raw_logic.
--   ops         : footfall, targets, store health, diagnosis, action queue.
--   marketing   : DelightChat campaigns, imports, recipient-level metrics.
-- Every app-facing table lives outside raw_logic so a service-role Airbyte sync
-- can never be granted anon/authenticated access by accident.

-- Supabase auto-creates this schema for contrib extensions; vanilla Postgres
-- doesn't, so it needs creating explicitly here before moddatetime installs into it.
create schema if not exists extensions;

create extension if not exists pgcrypto;                          -- gen_random_uuid()
create extension if not exists moddatetime with schema extensions; -- auto-maintained updated_at columns

create schema if not exists raw_logic;
create schema if not exists core;
create schema if not exists sales;
create schema if not exists ops;
create schema if not exists marketing;

comment on schema raw_logic is 'Airbyte destination schema for Logic ERP sync. App roles have no direct grants here.';
comment on schema core      is 'Store master, retail calendar, RBAC.';
comment on schema sales     is 'Analytical views over raw_logic — bill/day/week/month rollups.';
comment on schema ops       is 'Footfall entry, targets, store health, diagnosis, action queue.';
comment on schema marketing is 'DelightChat campaigns, CSV import batches, recipient-level metrics.';

revoke all on schema raw_logic from anon, authenticated;

-- ===== 0002_retail_calendar.sql =====
-- =============================================================================
-- 0002 · Retail calendar (Mon→Sun weeks)
-- =============================================================================
-- Every WOW/MOM/YOY calculation in this platform joins through this table
-- rather than doing date arithmetic inline, so "what counts as a week" is
-- defined in exactly one place.

create table core.retail_calendar (
  date                date primary key,
  day_name            text not null,                 -- 'Monday' … 'Sunday'
  day_number          smallint not null,              -- 1 = Mon … 7 = Sun (ISO)
  week_start          date not null,                  -- Monday of this date's retail week
  week_end            date not null,                  -- Sunday of this date's retail week
  retail_week         smallint not null,               -- ISO week number, 1-53
  retail_year         smallint not null,               -- ISO week-year (handles Dec/Jan boundary weeks)
  retail_month        smallint not null,               -- calendar month, 1-12
  retail_month_name   text not null,
  retail_quarter      smallint not null,
  financial_year      text not null,                   -- e.g. 'FY2026-27', assumes Apr–Mar; adjust if different
  month_start         date not null,
  month_end           date not null,
  is_weekend          boolean not null,
  prev_retail_week_start date not null,                -- week_start - 7, for WOW joins
  same_week_last_year_start date not null              -- ISO week-aligned, not naive -365d
);

create index idx_retail_calendar_week_start on core.retail_calendar (week_start);
create index idx_retail_calendar_month_start on core.retail_calendar (month_start);
create index idx_retail_calendar_retail_year_week on core.retail_calendar (retail_year, retail_week);

comment on column core.retail_calendar.same_week_last_year_start is
  'Monday of the ISO week one year prior with the same retail_week number — used for YOY on equivalent retail periods rather than naive date - 365.';

-- Populate a wide range up front (2023-2028 covers several years either side of
-- go-live; extend later by re-running with new bounds — INSERT ... ON CONFLICT
-- DO NOTHING makes that safe to repeat).
insert into core.retail_calendar
select
  d,
  to_char(d, 'FMDay'),
  extract(isodow from d)::smallint,
  d - (extract(isodow from d)::int - 1),
  d - (extract(isodow from d)::int - 1) + 6,
  extract(week from d)::smallint,
  extract(isoyear from d)::smallint,
  extract(month from d)::smallint,
  to_char(d, 'FMMonth'),
  extract(quarter from d)::smallint,
  case when extract(month from d) >= 4
       then 'FY' || extract(year from d)::int::text || '-' || right((extract(year from d)::int + 1)::text, 2)
       else 'FY' || (extract(year from d)::int - 1)::text || '-' || right(extract(year from d)::int::text, 2)
  end,
  date_trunc('month', d)::date,
  (date_trunc('month', d) + interval '1 month' - interval '1 day')::date,
  extract(isodow from d) in (6, 7),
  d - (extract(isodow from d)::int - 1) - 7,
  d - (extract(isodow from d)::int - 1) - 364    -- 52 ISO weeks back, same weekday
from (
  select generate_series('2023-01-01'::date, '2028-12-31'::date, interval '1 day')::date as d
) series
on conflict (date) do nothing;

-- ===== 0003_core_stores_rbac.sql =====
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

-- ===== 0004_sales_base_view.sql =====
-- =============================================================================
-- 0004 · Base cleaned view over the Airbyte-synced Logic ERP feed
-- =============================================================================
-- ██ UNVERIFIED — Airbyte is not connected yet (confirmed 2026-08-08). ██
-- Everything below raw_logic.sales_transactions is a PLACEHOLDER guessed from
-- the sample report's column headers, not from a real synced table. Do not
-- treat this file as done until someone has:
--   1. Set up the Airbyte connector against the Logic SQL view.
--   2. Opened the actual destination table in Supabase and compared its real
--      name and column names/types against the block below.
--   3. Rewritten this file to match — most likely just renaming columns and
--      possibly deleting the text/date CASE branch under "join core.stores"
--      below if bill_date lands as a native date type (see the inline NOTE).
-- Nothing downstream (sales.*, ops.*) needs to change when this file is
-- corrected — every other view builds on sales.vw_ebo_sales_lines defined
-- here, never on raw_logic directly. This is the ONE file to revisit.
--
--   raw_logic.sales_transactions (   -- ← guessed name, verify against Airbyte
--     branch_name         text,
--     bill_date           text | date,   -- report exports it as 'DD/MM/YYYY' text; a live DB view usually gives a real date
--     bill_no              text,
--     item_code             text,
--     total_quantity        numeric,
--     gross_amount           numeric,
--     net_amount              numeric,
--     scheme_name              text,
--     scheme_group_name        text,
--     _airbyte_extracted_at    timestamptz
--   )
--
-- Three load-time defects discovered against the sample extract, all handled here:
--   1. The report embeds its own subtotal rows ('BRANCH WISE TOTALS', 'GRAND
--      TOTALS') and a merged title row. Excluded by bill_no filter + NOT NULL checks.
--   2. Two non-EBO channels (WAREHOUSE-*, OFFICE-*) ship through the same view
--      at ~230x the volume of the two real stores. Excluded by joining only
--      to onboarded core.stores rows.
--   3. Blank scheme is a single space (' '), not NULL. Normalized with NULLIF(TRIM(...), '').

-- ██ TEMPORARY STUB — DELETE THIS BLOCK once Airbyte actually lands the real
-- table. ██ Without it sales.vw_ebo_sales_lines below has nothing to compile
-- against and every migration after this one is blocked. This creates an
-- EMPTY table matching the guessed shape so the rest of the schema
-- (0005-0011) can deploy and be reviewed now. When Airbyte is connected:
-- check whether it creates raw_logic.sales_transactions itself (likely under
-- a different name, e.g. prefixed with the source stream name) — if so,
-- DROP this stub and repoint the view at the real table/columns per the
-- ASSUMPTION note above, rather than assuming Airbyte will just write into
-- this stub.
create table if not exists raw_logic.sales_transactions (
  branch_name         text,
  bill_date            text,
  bill_no               text,
  item_code              text,
  total_quantity          numeric,
  gross_amount             numeric,
  net_amount                numeric,
  scheme_name                text,
  scheme_group_name           text,
  _airbyte_extracted_at        timestamptz default now()
);

create or replace view sales.vw_ebo_sales_lines
with (security_invoker = on) as
select
  s.store_id,
  parsed.branch_date                                              as bill_date,
  st.bill_no,
  case
    when left(st.bill_no, 2) = 'SB' then 'SALE'
    when left(st.bill_no, 2) = 'RB' then 'RETURN'
    else 'OTHER'
  end                                                              as bill_type,
  st.item_code,
  st.total_quantity,
  st.gross_amount,
  st.net_amount,
  (st.gross_amount - st.net_amount)                                as discount_amount,
  nullif(trim(st.scheme_name), '')                                 as scheme_name,
  nullif(trim(st.scheme_group_name), '')                           as scheme_group_name
from raw_logic.sales_transactions st
  -- NOTE: this branch assumes bill_date syncs as text. If the Airbyte connector
  -- lands it as a native `date` column instead, this whole lateral collapses to
  -- `st.bill_date as branch_date` — the regex match below will not compile
  -- against a date-typed column, so this is a required edit, not optional.
  cross join lateral (
    select case
      when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$'
        then to_date(st.bill_date, 'DD/MM/YYYY')
      else st.bill_date::date
    end as branch_date
  ) parsed
  join core.stores s on s.branch_name_erp = st.branch_name and s.is_active
where st.branch_name is not null
  and st.bill_no not in ('BRANCH WISE TOTALS', 'GRAND TOTALS');

comment on view sales.vw_ebo_sales_lines is
  'Line grain: store x date x bill x item. The single choke point every other sales.* view builds on — fix a data-quality issue here once, not in six places.';

-- security_invoker requires Postgres 15+ (Supabase default). It makes this view
-- run with the caller''s privileges instead of the view owner''s, so RLS on any
-- table it touches is respected. raw_logic has no end-user grants at all, so in
-- practice this view is only reachable through server-side code using the
-- service role, or through the store-filtered views in 0005 below.
revoke all on sales.vw_ebo_sales_lines from anon, authenticated;

-- ===== 0005_sales_rollup_views.sql =====
-- =============================================================================
-- 0005 · Bill / daily / weekly / monthly analytical views
-- =============================================================================
-- These are the views the app actually queries. Each is store-filtered via
-- core.fn_user_store_ids() so an ebo_manager querying sales.vw_ebo_sales_daily
-- transparently gets only their own store's rows — no per-query WHERE needed
-- in application code, and no risk of forgetting it.

-- ---------------------------------------------------------------------------
-- Bill level. A bill can mix scheme groups (20 of 604 sample bills did) —
-- "dominant scheme group" = whichever scheme group sums to the largest net
-- contribution on that bill, chosen deterministically via DISTINCT ON, not
-- picked arbitrarily or by first-seen line.
-- ---------------------------------------------------------------------------
create or replace view sales.vw_ebo_bill
with (security_invoker = on) as
with bill_agg as (
  select
    store_id, bill_date, bill_no, bill_type,
    sum(total_quantity)                       as quantity,
    sum(gross_amount)                         as gross_amount,
    sum(net_amount)                           as net_amount,
    sum(discount_amount)                      as discount_amount,
    count(*)                                  as line_count,
    bool_or(scheme_name is not null)          as has_scheme,
    count(distinct scheme_group_name) filter (where scheme_group_name is not null) as scheme_group_count
  from sales.vw_ebo_sales_lines
  where store_id = any (core.fn_user_store_ids())
  group by store_id, bill_date, bill_no, bill_type
),
scheme_group_totals as (
  select store_id, bill_date, bill_no, scheme_group_name, sum(net_amount) as group_net
  from sales.vw_ebo_sales_lines
  where store_id = any (core.fn_user_store_ids())
    and scheme_group_name is not null
  group by store_id, bill_date, bill_no, scheme_group_name
),
dominant_scheme as (
  select distinct on (store_id, bill_date, bill_no)
    store_id, bill_date, bill_no,
    scheme_group_name as dominant_scheme_group
  from scheme_group_totals
  order by store_id, bill_date, bill_no, group_net desc
)
select
  a.store_id, a.bill_date, a.bill_no, a.bill_type,
  a.quantity, a.gross_amount, a.net_amount, a.discount_amount, a.line_count,
  a.has_scheme, a.scheme_group_count, d.dominant_scheme_group,
  false as campaign_flag  -- placeholder: set true once bill<->campaign attribution (Phase 3) is wired
from bill_agg a
left join dominant_scheme d using (store_id, bill_date, bill_no);

comment on view sales.vw_ebo_bill is
  'One row per bill (SALE or RETURN). scheme_group_count > 1 flags bills that mix scheme groups — dominant_scheme_group breaks the tie by net value, never silently first-wins.';

-- ---------------------------------------------------------------------------
-- Daily store performance — the grain every KPI card and diagnosis reads from.
--
-- Built off a store x calendar-day spine, not a plain GROUP BY on bills. A
-- day with zero bills (store closed, or just a dead Tuesday) still must
-- produce a row with net_sales = 0 — otherwise it's indistinguishable from a
-- day outside the loaded date range, and sales.vw_ebo_sales_weekly's
-- is_complete_week flag (below) would silently mislabel a week with a real
-- zero-sale day as "in progress" or vice versa.
-- ---------------------------------------------------------------------------
create or replace view sales.vw_ebo_sales_daily
with (security_invoker = on) as
with spine as (
  select s.store_id, rc.date as bill_date, rc.day_name, rc.week_start, rc.retail_week,
         rc.retail_year, rc.retail_month, rc.retail_quarter, rc.financial_year, rc.is_weekend
  from core.stores s
  -- coalesce(s.opened_date, rc.date) falls back to rc.date itself when a store
  -- has no opened_date on file, which collapses the lower bound away (rc.date
  -- between rc.date and current_date ≡ rc.date <= current_date) instead of
  -- excluding the store from the spine entirely.
  join core.retail_calendar rc
    on rc.date between coalesce(s.opened_date, rc.date) and current_date
  where s.is_active
    and s.store_id = any (core.fn_user_store_ids())
),
bill_totals as (
  select
    store_id, bill_date,
    count(*) filter (where bill_type = 'SALE')                          as sale_bills,
    count(*) filter (where bill_type = 'RETURN')                        as return_bills,
    sum(quantity)                                                       as net_quantity,
    sum(gross_amount)                                                   as gross_sales,
    sum(discount_amount)                                                as discount,
    sum(net_amount)                                                     as net_sales,
    sum(net_amount) filter (where bill_type = 'RETURN')                 as returns_value,
    sum(net_amount) filter (where bill_type = 'SALE')                   as sale_net_amount,
    sum(quantity) filter (where bill_type = 'SALE')                     as sale_quantity
  from sales.vw_ebo_bill
  group by store_id, bill_date
)
select
  spine.store_id, spine.bill_date, spine.day_name, spine.week_start, spine.retail_week,
  spine.retail_year, spine.retail_month, spine.retail_quarter, spine.financial_year, spine.is_weekend,
  coalesce(t.sale_bills, 0)          as sale_bills,
  coalesce(t.return_bills, 0)        as return_bills,
  coalesce(t.net_quantity, 0)        as net_quantity,
  coalesce(t.gross_sales, 0)         as gross_sales,
  coalesce(t.discount, 0)            as discount,
  coalesce(t.net_sales, 0)           as net_sales,
  coalesce(t.returns_value, 0)       as returns_value,
  round(t.sale_net_amount / nullif(t.sale_bills, 0), 2)                  as atv,
  round(t.sale_quantity / nullif(t.sale_bills, 0)::numeric, 3)           as upt,
  round(100.0 * coalesce(t.discount, 0) / nullif(t.gross_sales, 0), 2)   as discount_pct,
  coalesce(t.sale_quantity, 0)       as sale_quantity  -- appended last: CREATE OR REPLACE VIEW cannot reorder or insert columns mid-list, only append
from spine
left join bill_totals t using (store_id, bill_date);

comment on view sales.vw_ebo_sales_daily is
  'One row per store per calendar day, always — zero-sale days included with net_sales = 0 rather than simply absent. ATV/UPT stay NULL (not 0) on a zero-bill day, since dividing by zero bills is undefined, not a bad basket. Conversion is deliberately absent here; it lives in ops.vw_ebo_conversion_daily, which LEFT JOINs footfall and is NULL, not 0, on days with no footfall entry.';

-- ---------------------------------------------------------------------------
-- Retail-week rollup (Mon→Sun)
-- ---------------------------------------------------------------------------
create or replace view sales.vw_ebo_sales_weekly
with (security_invoker = on) as
select
  store_id, week_start, retail_week, retail_year,
  min(bill_date)                          as week_first_day_with_data,
  max(bill_date)                          as week_last_day_with_data,
  count(distinct bill_date)               as days_with_data,
  (max(bill_date) - min(week_start))::int >= 6                       as is_complete_week,
  sum(sale_bills)                         as sale_bills,
  sum(return_bills)                       as return_bills,
  sum(net_quantity)                       as net_quantity,
  sum(gross_sales)                        as gross_sales,
  sum(discount)                           as discount,
  sum(net_sales)                          as net_sales,
  round(sum(net_sales) / nullif(sum(sale_bills), 0), 2)                     as atv,
  round(100.0 * sum(discount) / nullif(sum(gross_sales), 0), 2)             as discount_pct,
  sum(sale_quantity)                                                       as sale_quantity,
  round(sum(sale_quantity) / nullif(sum(sale_bills), 0)::numeric, 3)        as upt
from sales.vw_ebo_sales_daily
group by store_id, week_start, retail_week, retail_year;

comment on view sales.vw_ebo_sales_weekly is
  'is_complete_week is false for the current in-progress week — the app must label it (e.g. "6 of 7 days") rather than compare it to a full prior week as if equivalent.';

-- ---------------------------------------------------------------------------
-- Monthly rollup
-- ---------------------------------------------------------------------------
create or replace view sales.vw_ebo_sales_monthly
with (security_invoker = on) as
select
  store_id,
  date_trunc('month', bill_date)::date    as month_start,
  retail_month, retail_quarter, retail_year, financial_year,
  sum(sale_bills)                         as sale_bills,
  sum(return_bills)                       as return_bills,
  sum(net_quantity)                       as net_quantity,
  sum(gross_sales)                        as gross_sales,
  sum(discount)                           as discount,
  sum(net_sales)                          as net_sales,
  round(sum(net_sales) / nullif(sum(sale_bills), 0), 2) as atv,
  round(100.0 * sum(discount) / nullif(sum(gross_sales), 0), 2) as discount_pct,
  sum(sale_quantity)                                                  as sale_quantity,
  round(sum(sale_quantity) / nullif(sum(sale_bills), 0)::numeric, 3)  as upt
from sales.vw_ebo_sales_daily
group by store_id, date_trunc('month', bill_date), retail_month, retail_quarter, retail_year, financial_year;

-- ---------------------------------------------------------------------------
-- Scheme / campaign-flag performance (Section 17 of the brief)
-- ---------------------------------------------------------------------------
create or replace view sales.vw_ebo_scheme_daily
with (security_invoker = on) as
select
  store_id, bill_date,
  coalesce(dominant_scheme_group, 'NO SCHEME')          as scheme_group,
  count(*) filter (where bill_type = 'SALE')             as bills,
  sum(quantity) filter (where bill_type = 'SALE')        as quantity,
  sum(gross_amount) filter (where bill_type = 'SALE')    as gross_sales,
  sum(discount_amount) filter (where bill_type = 'SALE') as discount,
  sum(net_amount) filter (where bill_type = 'SALE')      as net_sales
from sales.vw_ebo_bill
group by store_id, bill_date, coalesce(dominant_scheme_group, 'NO SCHEME');

grant select on sales.vw_ebo_bill, sales.vw_ebo_sales_daily, sales.vw_ebo_sales_weekly,
                 sales.vw_ebo_sales_monthly, sales.vw_ebo_scheme_daily
  to authenticated;

-- ===== 0006_footfall.sql =====
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

-- ===== 0007_targets.sql =====
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

-- ===== 0008_store_health.sql =====
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

-- ===== 0009_diagnosis_opportunities.sql =====
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

-- ===== 0010_marketing_campaigns.sql =====
-- =============================================================================
-- 0010 · DelightChat campaigns, CSV import, recipient-level metrics
-- =============================================================================
-- Grain decision, from the real export: DelightChat gives one row per
-- recipient with no campaign name, store, year, or order data. All four are
-- captured at upload time (the "fill gaps" step in the import mock) and
-- stored on campaign_import_batches / campaigns — never guessed from the file.

create table marketing.campaign_import_batches (
  id              uuid primary key default gen_random_uuid(),
  file_name       text not null,
  uploaded_by     uuid references core.profiles (user_id),
  uploaded_at     timestamptz not null default now(),
  column_mapping  jsonb not null,          -- the saved {csv_column: internal_field} profile used for this import
  row_count       integer not null,
  success_count   integer not null default 0,
  failed_count    integer not null default 0,
  duplicate_count integer not null default 0,
  status          text not null default 'pending' check (status in ('pending', 'committed', 'failed')),
  error_log       jsonb
);

create table marketing.campaigns (
  id                    uuid primary key default gen_random_uuid(),
  external_campaign_id  text,                        -- DelightChat broadcast ID, when available
  campaign_name         text not null,                -- user-supplied at import; the file has no such column
  campaign_date         date not null,                 -- user-supplied; file timestamp has no year
  campaign_type         text,                           -- 'low_footfall' | 'reactivation' | 'promotion' | 'new_collection' | 'store_event' | 'local_marketing' | 'other'
  campaign_status       text not null default 'recommended'
    check (campaign_status in ('recommended','requested','approved','rejected','in_progress','completed','result_measured')),
  requested_by          uuid references core.profiles (user_id),
  approved_by            uuid references core.profiles (user_id),
  template               text,
  offer                   text,
  description              text,
  import_batch_id          uuid references marketing.campaign_import_batches (id),
  created_at                timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

-- A campaign can target more than one store (the sample broadcast covered both
-- BO-001 and BO-003) — many-to-many, not a single store_id column on campaigns.
create table marketing.campaign_stores (
  campaign_id  uuid not null references marketing.campaigns (id) on delete cascade,
  store_id     text not null references core.stores (store_id),
  primary key (campaign_id, store_id)
);

-- Recipient grain, matching the export exactly. NOT flattened into
-- campaign_metrics at upload — the per-error-code breakdown (screen 07's
-- actual finding: 77% of failures share one Meta error code) only exists at
-- this grain.
create table marketing.campaign_recipients (
  id                      uuid primary key default gen_random_uuid(),
  campaign_id             uuid not null references marketing.campaigns (id) on delete cascade,
  import_batch_id         uuid references marketing.campaign_import_batches (id),
  recipient_phone         text not null,
  recipient_name          text,
  sent_at                 timestamptz,
  attempted               boolean not null default false,
  sent                    boolean not null default false,
  delivered               boolean not null default false,
  read                    boolean not null default false,
  failed                  boolean not null default false,
  error_code              text,
  failure_reason          text,
  status_flags_conflict   boolean not null default false,  -- true for the delivered-not-sent / read-not-delivered rows the sample export contained
  attributed_order_id     text,     -- Phase 3, once order-level join exists
  attributed_revenue      numeric(12,2),
  -- Fingerprint used for duplicate-import protection: same campaign + same
  -- phone re-uploaded updates this row rather than inserting a second one.
  unique (campaign_id, recipient_phone)
);

create index idx_campaign_recipients_campaign on marketing.campaign_recipients (campaign_id);
create index idx_campaign_recipients_error on marketing.campaign_recipients (error_code) where error_code is not null;

-- Aggregated metrics, derived FROM campaign_recipients (never entered directly)
-- — Section 19's campaign_metrics table, computed as a view so it can never
-- drift from the recipient-level rows.
create or replace view marketing.vw_campaign_metrics
with (security_invoker = on) as
select
  campaign_id,
  count(*) filter (where attempted)                                          as sent_count_attempted,
  count(*) filter (where sent)                                                as sent_count,
  count(*) filter (where delivered)                                           as delivered_count,
  count(*) filter (where failed)                                              as failed_count,
  count(*) filter (where read)                                                as read_count,
  round(100.0 * count(*) filter (where delivered) / nullif(count(*) filter (where sent), 0), 2)  as delivery_rate,
  round(100.0 * count(*) filter (where read) / nullif(count(*) filter (where delivered), 0), 2)  as read_rate,
  count(*) filter (where attributed_order_id is not null)                     as attributed_orders,
  sum(attributed_revenue)                                                     as attributed_revenue,
  count(*) filter (where status_flags_conflict)                               as contradictory_status_count
from marketing.campaign_recipients
group by campaign_id;

create or replace view marketing.vw_campaign_failure_reasons
with (security_invoker = on) as
select
  campaign_id, error_code, failure_reason,
  count(*)                                     as recipient_count,
  round(100.0 * count(*) / sum(count(*)) over (partition by campaign_id), 1) as pct_of_failures
from marketing.campaign_recipients
where failed
group by campaign_id, error_code, failure_reason;

-- ---------------------------------------------------------------------------
-- Campaign impact on store sales — three explicit evidence tiers (Section 22).
-- Never labelled ROI; never captions correlation as causation.
-- ---------------------------------------------------------------------------
create or replace view marketing.vw_campaign_store_impact
with (security_invoker = on) as
select
  cs.campaign_id, cs.store_id, c.campaign_date,
  pre.net_sales   as net_sales_7d_before,
  post.net_sales  as net_sales_7d_after,
  round(100.0 * (post.net_sales - pre.net_sales) / nullif(pre.net_sales, 0), 2) as sales_change_pct,
  case
    when exists (select 1 from marketing.campaign_recipients r where r.campaign_id = cs.campaign_id and r.attributed_order_id is not null)
      then 'DIRECT_ATTRIBUTION'
    else 'OBSERVATIONAL_CHANGE'
  end as evidence_tier
from marketing.campaign_stores cs
join marketing.campaigns c on c.id = cs.campaign_id
left join lateral (
  select sum(net_sales) as net_sales from sales.vw_ebo_sales_daily
  where store_id = cs.store_id and bill_date between c.campaign_date - 7 and c.campaign_date - 1
) pre on true
left join lateral (
  select sum(net_sales) as net_sales from sales.vw_ebo_sales_daily
  where store_id = cs.store_id and bill_date between c.campaign_date and c.campaign_date + 6
) post on true;

comment on view marketing.vw_campaign_store_impact is
  'evidence_tier is DIRECT_ATTRIBUTION only once campaign_recipients.attributed_order_id is populated by a phone-number join against the ERP bill (Phase 3 — customer phone is confirmed captured at billing but not yet exposed in the sales SQL view). Until then every row is OBSERVATIONAL_CHANGE, and the app must show the day-of-week composition of the before/after windows alongside this — a weekend-heavy post-window inflates sales_change_pct for reasons having nothing to do with the campaign.';

grant select on marketing.vw_campaign_metrics, marketing.vw_campaign_failure_reasons,
                 marketing.vw_campaign_store_impact
  to authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table marketing.campaign_import_batches enable row level security;
alter table marketing.campaigns enable row level security;
alter table marketing.campaign_stores enable row level security;
alter table marketing.campaign_recipients enable row level security;

create policy campaigns_read on marketing.campaigns for select using (true);
create policy campaigns_write on marketing.campaigns for insert with check (
  core.fn_user_role() in ('marketing', 'ho_admin', 'super_admin')
);
create policy campaigns_update on marketing.campaigns for update using (
  core.fn_user_role() in ('marketing', 'ho_admin', 'super_admin')
);

create policy campaign_stores_read on marketing.campaign_stores for select using (
  store_id = any (core.fn_user_store_ids())
);
create policy campaign_stores_write on marketing.campaign_stores for insert with check (
  core.fn_user_role() in ('marketing', 'ho_admin', 'super_admin')
);

create policy campaign_recipients_read on marketing.campaign_recipients for select using (
  core.fn_user_role() in ('marketing', 'ho_admin', 'super_admin')
);
create policy campaign_recipients_write on marketing.campaign_recipients for insert with check (
  core.fn_user_role() in ('marketing', 'ho_admin', 'super_admin')
);

create policy import_batches_rw on marketing.campaign_import_batches for all using (
  core.fn_user_role() in ('marketing', 'ho_admin', 'super_admin')
) with check (
  core.fn_user_role() in ('marketing', 'ho_admin', 'super_admin')
);

-- ===== 0011_schema_grants.sql =====
-- =============================================================================
-- 0011 · Schema-level grants
-- =============================================================================
-- Table/view GRANTs in earlier files are inert without USAGE on the schema —
-- Postgres checks both. raw_logic deliberately gets none of this.

grant usage on schema core, sales, ops, marketing to authenticated;

grant select on core.stores to authenticated;
grant select on core.retail_calendar to authenticated;

-- Everything else was granted per-object in its own migration file, next to
-- the RLS policy that governs it, so the two are easy to review together.

-- ===== 0012_fix_profiles_grants.sql =====
-- =============================================================================
-- 0012 · Fix missing base grants on core.profiles / core.user_store_access
-- =============================================================================
-- 0003_core_stores_rbac.sql wrote RLS policies for these two tables but
-- never granted the underlying SELECT privilege to `authenticated` — Postgres
-- checks table-level GRANTs before RLS is even considered, so every request
-- (including a user reading their own profile) failed with a permission
-- error. The app had no error handling for that specific failure and
-- silently treated it identically to "no profile row exists", which is what
-- surfaced as every real, correctly-provisioned user being redirected to
-- "your account isn't set up yet".
--
-- Deliberately SELECT only — INSERT/UPDATE on these tables stays restricted
-- to the service-role admin path (docs/rbac-auth-setup.md §1), unchanged.

grant select on core.profiles to authenticated;
grant select on core.user_store_access to authenticated;

-- ===== 0013_fix_remaining_grants.sql =====
-- =============================================================================
-- 0013 · Fix the same missing-grant bug across every remaining base table
-- =============================================================================
-- 0012 fixed core.profiles / core.user_store_access after it broke login.
-- Auditing every other RLS-protected base table turned up the identical gap
-- on all of them: a correct RLS policy was written, but the base-table
-- GRANT that must exist before Postgres even considers RLS was never added.
-- Each of these would have failed exactly like login did, one feature at a
-- time, as they were built out. Grants below are scoped to match exactly
-- what each table's existing RLS policies already allow — see the migration
-- that defines each policy for the authorization logic itself; this file
-- only adds the privilege layer underneath it.

-- ops — footfall, targets, action queue, health config, stock stub
grant select, insert, update on ops.ebo_footfall_daily        to authenticated; -- footfall_read / _write / _update
grant select, insert, update on ops.ebo_targets                to authenticated; -- targets_read / _write / _update
grant select, insert, update on ops.action_items                to authenticated; -- action_items_read / _insert / _update
grant select, insert, update, delete on ops.health_score_factors to authenticated; -- health_factors_read (all) / _write (ho_admin/super_admin only, via RLS)
grant select on ops.stock_availability_snapshot                   to authenticated; -- stock_snapshot_read — write is service-role/Phase 2 only, no write policy exists yet

-- marketing — campaigns, recipients, import batches
grant select, insert, update on marketing.campaigns                  to authenticated; -- campaigns_read / _write / _update
grant select, insert         on marketing.campaign_stores             to authenticated; -- campaign_stores_read / _write
grant select, insert, update on marketing.campaign_recipients          to authenticated; -- read/write policies; update needed for the ON CONFLICT DO UPDATE upsert pattern in supabase/README.md
grant select, insert, update, delete on marketing.campaign_import_batches to authenticated; -- import_batches_rw is `for all`

-- ===== 0014_fix_sales_lines_access.sql =====
-- =============================================================================
-- 0014 · Fix sales.vw_ebo_sales_lines being unreachable through its own
--        downstream views
-- =============================================================================
-- 0004 revoked all authenticated/anon access to this view on the theory
-- that it was "only reachable through the store-filtered views in 0005" —
-- that reasoning was wrong. Every view from here up through
-- vw_ebo_sales_weekly/_monthly is declared WITH (security_invoker = on),
-- which means the CALLING USER's own privileges are checked at every layer
-- of the chain, not just the outermost one. Revoking this view didn't
-- protect it — it broke every view built on top of it for every real user,
-- surfaced when the first real query through the full chain
-- (sales.vw_ebo_sales_weekly, from the network dashboard) returned
-- "permission denied for view vw_ebo_sales_lines".
--
-- The actual fix has two parts:
--   1. This view never filtered by store access itself — it only filtered
--      to branches present in core.stores (the WAREHOUSE/OFFICE channel
--      exclusion from 0004), not to which stores THIS caller may see. That
--      was fine when nothing could query it directly. Now that grants allow
--      direct queries, it needs its own core.fn_user_store_ids() filter —
--      redundant with vw_ebo_bill's filter one layer up, but correct: an
--      ebo_manager scoped to one store must not be able to read another
--      store's lines by querying this view directly instead of going
--      through the rollups.
--   2. Grant SELECT to authenticated now that the view enforces that scope
--      itself.

create or replace view sales.vw_ebo_sales_lines
with (security_invoker = on) as
select
  s.store_id,
  parsed.branch_date                                              as bill_date,
  st.bill_no,
  case
    when left(st.bill_no, 2) = 'SB' then 'SALE'
    when left(st.bill_no, 2) = 'RB' then 'RETURN'
    else 'OTHER'
  end                                                              as bill_type,
  st.item_code,
  st.total_quantity,
  st.gross_amount,
  st.net_amount,
  (st.gross_amount - st.net_amount)                                as discount_amount,
  nullif(trim(st.scheme_name), '')                                 as scheme_name,
  nullif(trim(st.scheme_group_name), '')                           as scheme_group_name
from raw_logic.sales_transactions st
  cross join lateral (
    select case
      when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$'
        then to_date(st.bill_date, 'DD/MM/YYYY')
      else st.bill_date::date
    end as branch_date
  ) parsed
  join core.stores s on s.branch_name_erp = st.branch_name and s.is_active
where st.branch_name is not null
  and st.bill_no not in ('BRANCH WISE TOTALS', 'GRAND TOTALS')
  and s.store_id = any (core.fn_user_store_ids());

comment on view sales.vw_ebo_sales_lines is
  'Line grain: store x date x bill x item. Filters to the caller''s accessible stores directly (core.fn_user_store_ids()) — do not assume downstream views provide this protection; with security_invoker = on throughout the chain, every view must be safe to query on its own.';

grant select on sales.vw_ebo_sales_lines to authenticated;

-- ===== 0015_sales_lines_security_barrier.sql =====
-- =============================================================================
-- 0015 · sales.vw_ebo_sales_lines must NOT be security_invoker
-- =============================================================================
-- 0014's fix was half right and broke one layer deeper: with
-- security_invoker = on, Postgres checks the CALLER's privileges against
-- every object the view touches — including raw_logic.sales_transactions
-- itself. The error from testing 0014 literally suggested
-- `GRANT SELECT ON raw_logic.sales_transactions TO authenticated`, which
-- would have defeated the entire point of 0001's
-- `revoke all on schema raw_logic from anon, authenticated` — any
-- authenticated user could then query the raw ERP table directly, bypassing
-- the branch filter that excludes WAREHOUSE-*/OFFICE-* channels, and
-- bypassing per-store scoping entirely.
--
-- This is the one view in the whole sales.* chain that should run as a
-- classic Postgres "security barrier" view instead: it executes with the
-- VIEW OWNER's privileges (who has legitimate access to raw_logic), not the
-- caller's. That does NOT reopen the per-user store leak, because the
-- row-filtering `where s.store_id = any(core.fn_user_store_ids())` depends
-- only on auth.uid() reading the request's JWT claims — that works
-- correctly regardless of which role's privileges the view executes under.
-- Every other view in sales.*/ops.*/marketing.* keeps security_invoker = on
-- as before; they only ever query THIS view (which they have a grant on),
-- never raw_logic directly, so they need no change.
--
-- security_barrier = true additionally stops the query planner from
-- evaluating caller-supplied filter conditions before this view's own WHERE
-- clause — the standard hardening for a view whose entire job is
-- restricting rows, not just convenience.

create or replace view sales.vw_ebo_sales_lines
with (security_invoker = off, security_barrier = true) as
select
  s.store_id,
  parsed.branch_date                                              as bill_date,
  st.bill_no,
  case
    when left(st.bill_no, 2) = 'SB' then 'SALE'
    when left(st.bill_no, 2) = 'RB' then 'RETURN'
    else 'OTHER'
  end                                                              as bill_type,
  st.item_code,
  st.total_quantity,
  st.gross_amount,
  st.net_amount,
  (st.gross_amount - st.net_amount)                                as discount_amount,
  nullif(trim(st.scheme_name), '')                                 as scheme_name,
  nullif(trim(st.scheme_group_name), '')                           as scheme_group_name
from raw_logic.sales_transactions st
  cross join lateral (
    select case
      when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$'
        then to_date(st.bill_date, 'DD/MM/YYYY')
      else st.bill_date::date
    end as branch_date
  ) parsed
  join core.stores s on s.branch_name_erp = st.branch_name and s.is_active
where st.branch_name is not null
  and st.bill_no not in ('BRANCH WISE TOTALS', 'GRAND TOTALS')
  and s.store_id = any (core.fn_user_store_ids());

comment on view sales.vw_ebo_sales_lines is
  'Line grain: store x date x bill x item. security_invoker = OFF, deliberately — this is the one view in the chain allowed to run as its owner so callers never need direct raw_logic privileges. Safe only because the store-scoping WHERE clause depends on auth.uid() (JWT-derived), not on privilege context. Every other sales.*/ops.*/marketing.* view keeps security_invoker = on and must never touch raw_logic directly — always go through this view.';

-- raw_logic stays locked down exactly as 0001 set it — nothing granted here.

-- ===== 0016_agent_and_bill_time.sql =====
-- =============================================================================
-- 0016 · Agent name + bill time — new columns in the latest source export
-- =============================================================================
-- The latest Logic extract adds two columns the earlier one didn't have:
-- AGENT NAME ("003 - RUPALI SHIRSATH" — branch-code-prefixed, but not every
-- row follows that pattern, e.g. "NAVNATH SATHE" and "MANSA CLOTHING" have
-- none, so agent_name is stored as free text, not parsed into a code/name
-- pair) and BILL TIME ("05:58:00 PM" text, 12-hour with AM/PM). Also found
-- while profiling this file: 11 of 18,178 rows have a null NET AMOUNT with a
-- populated GROSS AMOUNT — handled by treating a null net as "no discount"
-- (coalesce to gross), not by dropping the row.

alter table raw_logic.sales_transactions
  add column if not exists agent_name text,
  add column if not exists bill_time  text;

create or replace view sales.vw_ebo_sales_lines
with (security_invoker = off, security_barrier = true) as
select
  s.store_id,
  parsed.branch_date                                              as bill_date,
  st.bill_no,
  case
    when left(st.bill_no, 2) = 'SB' then 'SALE'
    when left(st.bill_no, 2) = 'RB' then 'RETURN'
    else 'OTHER'
  end                                                              as bill_type,
  st.item_code,
  st.total_quantity,
  st.gross_amount,
  coalesce(st.net_amount, st.gross_amount)                        as net_amount,
  (st.gross_amount - coalesce(st.net_amount, st.gross_amount))     as discount_amount,
  nullif(trim(st.scheme_name), '')                                 as scheme_name,
  nullif(trim(st.scheme_group_name), '')                           as scheme_group_name,
  nullif(trim(st.agent_name), '')                                  as agent_name,
  parsed.bill_time_parsed                                          as bill_time
from raw_logic.sales_transactions st
  cross join lateral (
    select
      case
        when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$'
          then to_date(st.bill_date, 'DD/MM/YYYY')
        else st.bill_date::date
      end as branch_date,
      case
        when st.bill_time ~ '^\d{2}:\d{2}:\d{2} (AM|PM)$'
          then to_timestamp(st.bill_time, 'HH12:MI:SS AM')::time
        else null
      end as bill_time_parsed
  ) parsed
  join core.stores s on s.branch_name_erp = st.branch_name and s.is_active
where st.branch_name is not null
  and st.bill_no not in ('BRANCH WISE TOTALS', 'GRAND TOTALS')
  and s.store_id = any (core.fn_user_store_ids());

comment on view sales.vw_ebo_sales_lines is
  'Line grain: store x date x bill x item, plus agent_name and bill_time where the source provides them (both nullable — not every Logic export version has had these columns). security_invoker = OFF, deliberately — see 0015 for why.';

-- ===== 0017_agent_and_hourly_views.sql =====
-- =============================================================================
-- 0017 · Agent-wise and hour-of-day sales views
-- =============================================================================
-- Both requested for the network dashboard. Built directly off
-- sales.vw_ebo_sales_lines (SALE lines only — agent attribution on a return
-- line just tells you who processed the refund, not who made the sale, so
-- returns are excluded rather than counted against an agent's numbers).

create or replace view sales.vw_ebo_agent_daily
with (security_invoker = on) as
select
  store_id,
  bill_date,
  coalesce(agent_name, 'Unassigned')                    as agent_name,
  count(distinct bill_no)                                as bills,
  sum(total_quantity)                                     as quantity,
  sum(gross_amount)                                        as gross_sales,
  sum(discount_amount)                                      as discount,
  sum(net_amount)                                            as net_sales
from sales.vw_ebo_sales_lines
where bill_type = 'SALE'
group by store_id, bill_date, coalesce(agent_name, 'Unassigned');

comment on view sales.vw_ebo_agent_daily is
  'One row per store x day x agent. "Unassigned" covers rows with no agent_name — most likely older exports from before that column existed, not missing data on a given line.';

create or replace view sales.vw_ebo_sales_hourly
with (security_invoker = on) as
select
  store_id,
  bill_date,
  extract(hour from bill_time)::smallint                as bill_hour,
  count(distinct bill_no)                                 as bills,
  sum(total_quantity)                                      as quantity,
  sum(net_amount)                                           as net_sales
from sales.vw_ebo_sales_lines
where bill_type = 'SALE' and bill_time is not null
group by store_id, bill_date, extract(hour from bill_time);

comment on view sales.vw_ebo_sales_hourly is
  'Rows only exist for lines with a parseable bill_time — silently absent, not zero, for any date/store where the source didn''t supply a time (older exports). The app must not read a missing hour as "no sales that hour".';

grant select on sales.vw_ebo_agent_daily, sales.vw_ebo_sales_hourly to authenticated;

-- ===== 0018_incentive_target_imports.sql =====
-- =============================================================================
-- 0018 · Incentive target import — upload provision only
-- =============================================================================
-- Day-wise qty/value targets per store, uploaded as an Excel file, for
-- incentive calculations. Parsing/validation is explicitly NOT built yet —
-- this migration only provides somewhere safe to land the file and a record
-- that it was uploaded. Follow the pattern in marketing.campaign_import_batches
-- when the actual parsing gets built: validate → preview → commit, never a
-- direct parse-and-insert on upload.

create table ops.incentive_target_imports (
  id            uuid primary key default gen_random_uuid(),
  file_name     text not null,
  storage_path  text not null,          -- path within the incentive-targets bucket
  uploaded_by   uuid references core.profiles (user_id),
  uploaded_at   timestamptz not null default now(),
  status        text not null default 'uploaded' check (status in ('uploaded', 'processed', 'failed')),
  notes         text
);

alter table ops.incentive_target_imports enable row level security;

create policy incentive_target_imports_rw on ops.incentive_target_imports for all
  using (core.fn_user_role() in ('ho_admin', 'super_admin'))
  with check (core.fn_user_role() in ('ho_admin', 'super_admin'));

grant select, insert, update on ops.incentive_target_imports to authenticated;

-- No storage.buckets/storage.objects here — that was Supabase Storage.
-- Self-hosted file storage (local disk or MinIO) is the API service's
-- responsibility, not the database's; storage_path above is just wherever
-- the API decides to put the file. Access control for "who can upload" is
-- already covered by the ho_admin/super_admin check in the API route itself
-- plus the RLS policy on this table.

