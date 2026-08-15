-- =============================================================================
-- 0045 · Grant service_role the privileges the admin client actually needs
-- =============================================================================
-- APPLY THIS ON THE IN-HOUSE SERVER (192.168.1.16) with psql, per the
-- project's normal migration workflow. It is NOT for the legacy Supabase
-- cloud project (which is being decommissioned).
--
-- Found while removing Supabase: the Keycloak service-account client
-- (SELFHOSTED_KEYCLOAK_SERVICE_CLIENT_ID=ebo-postgrest) authenticates
-- correctly and PostgREST maps its token to the `service_role` Postgres role
-- — verified live, the JWT carries role=service_role. But service_role was
-- never granted anything on the `core` schema, so every request through
-- lib/data/admin.ts's createAdminClient() fails with:
--     42501  permission denied for table profiles
-- Postgres checks table-level GRANTs BEFORE RLS is considered, so a role that
-- "bypasses RLS" still gets nothing without them.
--
-- Practical effect until this is applied: every admin write on the Users page
-- is broken in production — inviteUser (core.profiles insert +
-- core.user_store_access insert), renameUser (profiles update),
-- updateUserStoreAccess (delete+insert), updateUserPageOverrides
-- (delete+insert on core.user_page_overrides). They fail at the DB layer
-- after the Keycloak side has already succeeded, which for inviteUser means a
-- half-provisioned user: a real Keycloak account with no core.profiles row,
-- i.e. someone who can authenticate but then gets bounced to
-- "not provisioned". Worth checking core.profiles against the Keycloak user
-- list for orphans after applying this.
--
-- Scope: exactly the tables the admin client writes, nothing wider. Reads
-- stay as they were; this adds the write privileges that were missing.

-- BYPASSRLS — the half of this that GRANTs alone do not cover.
-- 0021's header asserts "service_role bypasses RLS but NOT plain Postgres
-- GRANTs". The second half is right; the FIRST HALF IS WRONG on this
-- database. That claim is inherited from Supabase, where the service_role
-- role ships with the BYPASSRLS attribute. Here, `service_role` is never
-- created with it — grep the migrations: BYPASSRLS appears nowhere, and
-- 0000_bootstrap_roles.sql only creates `anon` and `authenticated`.
--
-- Verified empirically after the GRANTs below were applied: service_role
-- SELECTs on core.profiles returned HTTP 200 with ZERO rows, while the same
-- table read through a real super_admin session returned its rows normally.
-- The grants had landed; RLS was silently filtering everything out. Writes
-- would fail the same way — core.profiles has no INSERT/UPDATE policy at
-- all (deliberately, see 0012), so an RLS-subject role can never write to
-- it, which is exactly what the admin client needs to do.
--
-- Requires superuser to execute (the `postgres` role).
alter role service_role bypassrls;

grant usage on schema core to service_role;

grant select, insert, update, delete on core.profiles            to service_role;
grant select, insert, update, delete on core.user_store_access   to service_role;
grant select, insert, update, delete on core.user_page_overrides to service_role;
grant select                          on core.stores             to service_role;

-- integration_credentials is the other documented admin-client caller
-- (lib/data/admin.ts's header) — same treatment so it doesn't hit the
-- identical wall next time it's used.
grant select, insert, update, delete on core.integration_credentials to service_role;

-- PostgREST caches the schema/permission picture; without this it can keep
-- serving 42501 from a stale cache after the grants above have landed.
notify pgrst, 'reload schema';
