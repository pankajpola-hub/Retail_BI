-- =============================================================================
-- 0077 · Fix: 0075 granted SELECT on raw_logic.scheme_lookup but not USAGE
--        on the raw_logic SCHEMA — both are required, and only the table
--        grant was given, so it never actually worked for real callers.
-- =============================================================================
-- Found live: /targets showed "No targets set" despite real target rows
-- existing in ops.ebo_monthly_targets for the exact store/month being
-- viewed. Traced to ops.fn_monthly_fresh_disc_tracker (called by
-- app/(ho)/targets/page.tsx) — a plain SQL function, SECURITY INVOKER by
-- default (no SECURITY DEFINER declared), that joins
-- raw_logic.scheme_lookup directly. Confirmed via the real Supabase JS
-- client, signed in as an actual user: "permission denied for schema
-- raw_logic" — a SCHEMA-level check, which 0075's table-level `grant
-- select on raw_logic.scheme_lookup` does not satisfy on its own; Postgres
-- requires both USAGE on the schema and a privilege on the object inside
-- it. The targets_audit scheduled-export path (going through
-- ops.vw_monthly_fresh_disc_audit_lines, a security_invoker view whose own
-- sub-dependencies aren't all security_invoker) happened to still work
-- without this, which is why this specific gap wasn't caught when 0075 was
-- verified only through that path — a real caller hitting the function
-- directly (the normal live page, not the scheduled export) was still
-- broken until now.
--
-- Same deliberately narrow posture as 0075: only USAGE on the schema itself
-- (a namespace privilege, grants nothing on any table by itself) — every
-- individual raw_logic table's own SELECT grant stays exactly as locked
-- down as before; only raw_logic.scheme_lookup remains reachable, same as
-- 0075 intended.
-- =============================================================================

grant usage on schema raw_logic to authenticated;
grant usage on schema raw_logic to service_role;

notify pgrst, 'reload schema';
