-- =============================================================================
-- 0059 · core.app_settings needed a service_role GRANT — 0057 forgot it
-- =============================================================================
-- Same lesson 0045 already documented and 0021 already warned about: RLS
-- bypass (alter role service_role bypassrls, set in 0045) and plain Postgres
-- GRANTs are two independent gates — bypassing RLS does not imply having a
-- GRANT on the table. 0057 gave core.app_settings a SELECT policy and a
-- SELECT grant to `authenticated`, but never granted `service_role` write
-- access, so web/app/(configurations)/configurations/actions.ts's admin-
-- client write failed with "permission denied for table app_settings"
-- (42501) — caught immediately by an actual browser test of the Save
-- button, not assumed to work from the migration alone.
-- =============================================================================

grant select, insert, update, delete on core.app_settings to service_role;
