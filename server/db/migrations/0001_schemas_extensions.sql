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

-- `with schema extensions` matters and is not cosmetic: Supabase installs
-- pgcrypto into `extensions`, and every SECURITY DEFINER function that calls
-- pgp_sym_encrypt/gen_random_uuid sets `search_path = core, extensions,
-- pg_temp` (deliberately excluding public). Left to vanilla Postgres's
-- default this lands in `public` instead and those functions fail at runtime
-- with "function pgp_sym_encrypt(text, text) does not exist" — confirmed
-- live before this was pinned down.
create extension if not exists pgcrypto with schema extensions;    -- gen_random_uuid(), pgp_sym_encrypt()
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
