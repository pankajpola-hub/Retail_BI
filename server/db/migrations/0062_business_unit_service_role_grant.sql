-- =============================================================================
-- 0062 · core.user_business_units — grant service_role write access
-- =============================================================================
-- Same bug 0043/0045 already fixed once for core.profiles/user_store_access/
-- user_page_overrides: BYPASSRLS (which Supabase's service_role has by
-- default) only bypasses ROW LEVEL SECURITY POLICIES — it does NOT waive
-- ordinary table-level GRANT privileges. 0061's own header claimed "no
-- separate service_role grant statement needed here" — that was wrong,
-- caught by an actual insert attempt against the live table returning
-- "permission denied for table user_business_units", not by inspection.
-- 0061 only granted `select ... to authenticated`; nothing granted
-- service_role anything on this table at all, so createUser()/
-- updateUserBusinessUnits() (both using the service-role admin client) could
-- never have written to it.

grant select, insert, update, delete on core.user_business_units to service_role;

notify pgrst, 'reload schema';
