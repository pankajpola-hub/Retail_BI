-- =============================================================================
-- 0043 · Re-apply core.profiles grants + give service_role read access
-- =============================================================================
-- Diagnosing a live login failure ("Account is not fully set up" for a real,
-- previously-working super_admin). 0012_fix_profiles_grants.sql already
-- documents this EXACT symptom — SELECT on core.profiles never granted to
-- `authenticated`, so a legitimate user's own profile read fails with a
-- permission error the app can't distinguish from "no profile row exists"
-- and shows the same not_provisioned message either way.
--
-- 0012 is marked "applied" in this project's migration history, but this
-- session already found two other cases (0023/0025/0027, and
-- core.current_user_id() from 0003) where "marked applied" didn't mean the
-- live database actually matches the migration file's body — the DB's
-- history predates consistent CLI-driven migrations. Re-running a GRANT is
-- always safe (idempotent, no data/behavior change beyond the grant itself),
-- so re-applying it here costs nothing if 0012 was already fully live, and
-- fixes it if it wasn't.
--
-- Also grants service_role SELECT on the same tables/schema — the
-- service-role admin client (web/lib/supabase/admin.ts) had no schema-level
-- access to `core` at all (confirmed live: every service-role read against
-- core.profiles returned "permission denied for schema core"), which is
-- what actually blocked diagnosing this in the first place. service_role
-- already bypasses RLS by design; it still needs the underlying SQL GRANT,
-- same gap 0012 fixed for `authenticated`.

grant usage on schema core to service_role;
grant select on core.profiles to authenticated, service_role;
grant select on core.user_store_access to authenticated, service_role;
grant select on core.stores to service_role;
