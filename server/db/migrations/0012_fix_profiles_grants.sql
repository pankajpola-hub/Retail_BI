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
