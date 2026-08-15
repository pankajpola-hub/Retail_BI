-- =============================================================================
-- 0021 · Logic ERP connection credentials — storage only
-- =============================================================================
-- Holds the host/db/user/password for a direct connection to the Logic ERP
-- SQL Server on the LAN (the dormant "live sync" idea — see project notes).
-- Nothing in this app CONNECTS to that server yet; this is only a secure
-- place to land the details now so a future connector (Airbyte, or a small
-- sync service) doesn't need them re-collected. Do not build a "test
-- connection" feature against this table without re-checking that decision —
-- it was deliberately scoped out (store now, use later).
--
-- Access model, deliberately the strictest in this schema:
--   - RLS is enabled with NO policies at all -> default-deny for every
--     Postgres role including `authenticated`. A super_admin's own browser
--     session, using the normal anon/authenticated API key, cannot read or
--     write this table under any circumstance.
--   - The only way in is core.fn_save_logic_erp_credentials(), a
--     SECURITY DEFINER function granted to `service_role` only — meaning
--     only server-side code holding SUPABASE_SERVICE_ROLE_KEY (never sent to
--     the browser) can call it. See lib/supabase/admin.ts for the one-way
--     door that key already goes through.
--   - The password itself is pgp_sym_encrypt'd with a passphrase that is
--     NEVER stored in this database — it lives only in the
--     INTEGRATION_SECRET_KEY environment variable, server-side. Losing that
--     env var means the stored password is unrecoverable by design; that's
--     the intended failure mode, not a bug.

create table core.integration_credentials (
  id               uuid primary key default gen_random_uuid(),
  integration_name text not null unique,   -- 'logic_erp' — one row per external system, more can be added later
  host             text not null,
  port             integer not null,
  database_name    text not null,
  db_user          text not null,
  db_password_enc  bytea not null,
  notes            text,
  created_by       uuid references core.profiles (user_id),
  updated_by       uuid references core.profiles (user_id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table core.integration_credentials enable row level security;
-- No CREATE POLICY calls here — that absence is the point, see header.
revoke all on core.integration_credentials from anon, authenticated;

-- service_role bypasses RLS but NOT plain Postgres GRANTs — those are two
-- separate mechanisms, and this project's schemas were never opened up to
-- service_role before now (only `authenticated` got schema USAGE, in
-- 0011_schema_grants.sql). Without this, calling the SECURITY DEFINER
-- function below from createAdminClient() fails with "permission denied for
-- schema core" before it even gets to check the function's own grant.
-- PostgREST's connecting role must be able to SET ROLE into service_role,
-- or every service-role request fails with "permission denied to set role"
-- before it ever reaches a grant or policy check. anon/authenticated got
-- this in the postgrest bootstrap; service_role is created here, so the
-- membership grant belongs here too.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    grant service_role to authenticator;
  end if;
end
$$;

grant usage on schema core to service_role;
-- SELECT so the /integrations page can read back the safe metadata columns
-- (host/port/db name/user/updated_at) to show "already configured" state.
-- Nothing about this grant lets service_role bypass the encryption on
-- db_password_enc — that column is still useless without
-- INTEGRATION_SECRET_KEY, which lives only in the server's environment.
grant select on core.integration_credentials to service_role;

create trigger trg_integration_credentials_touch_updated_at
  before update on core.integration_credentials
  for each row execute function extensions.moddatetime(updated_at);

-- ---------------------------------------------------------------------------
-- Write path. One function per known integration (rather than a generic
-- "save any integration" function) so a future second integration doesn't
-- inherit assumptions — e.g. a REST API credential set looks nothing like a
-- SQL Server one.
-- ---------------------------------------------------------------------------
-- p_db_password is nullable: NULL means "keep whatever's already encrypted
-- there" (the form's "leave blank to keep the current one" path). Only
-- meaningful on an update — the INSERT branch requires a real password since
-- there's nothing yet to keep, enforced by the NOT NULL column constraint
-- rejecting a first-ever NULL insert outright.
create or replace function core.fn_save_logic_erp_credentials(
  p_host text,
  p_port integer,
  p_database_name text,
  p_db_user text,
  p_db_password text,
  p_passphrase text,
  p_updated_by uuid
) returns void
language plpgsql
security definer
set search_path = core, extensions, pg_temp
as $$
begin
  insert into core.integration_credentials
    (integration_name, host, port, database_name, db_user, db_password_enc, created_by, updated_by)
  values
    ('logic_erp', p_host, p_port, p_database_name, p_db_user,
     pgp_sym_encrypt(p_db_password, p_passphrase), p_updated_by, p_updated_by)
  on conflict (integration_name) do update set
    host            = excluded.host,
    port            = excluded.port,
    database_name   = excluded.database_name,
    db_user         = excluded.db_user,
    db_password_enc = case
      when p_db_password is null then core.integration_credentials.db_password_enc
      else excluded.db_password_enc
    end,
    updated_by      = excluded.updated_by;
end;
$$;

revoke all on function core.fn_save_logic_erp_credentials from public, anon, authenticated;
grant execute on function core.fn_save_logic_erp_credentials to service_role;

-- ---------------------------------------------------------------------------
-- Read-back path for whichever future service actually connects to Logic
-- ERP. Not called from anywhere in this app today — no API route exposes
-- it. Kept here so that work doesn't also require a schema migration.
-- ---------------------------------------------------------------------------
create or replace function core.fn_decrypt_logic_erp_password(p_passphrase text)
returns text
language plpgsql
security definer
set search_path = core, extensions, pg_temp
as $$
declare
  v_password text;
begin
  select pgp_sym_decrypt(db_password_enc, p_passphrase)
  into v_password
  from core.integration_credentials
  where integration_name = 'logic_erp';
  return v_password;
end;
$$;

revoke all on function core.fn_decrypt_logic_erp_password from public, anon, authenticated;
grant execute on function core.fn_decrypt_logic_erp_password to service_role;
