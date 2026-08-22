-- =============================================================================
-- 0074 · Fix: same class of gap as 0073, one schema over — service_role
--        never had access to `ops` either, beyond the two tables 0071/0072
--        explicitly granted it themselves.
-- =============================================================================
-- Confirmed live: triggering /api/cron/scheduled-exports for a
-- footfall_completeness schedule (after 0073 fixed the `sales`-schema half
-- of this same report) failed with "permission denied for view
-- vw_footfall_completeness" — caught loudly this time thanks to the error
-- checks 0073's own commit added to buildFootfallCompletenessReport, rather
-- than silently succeeding with an empty report the way it would have
-- before. A direct grant audit of every ops.* table/view then showed 18 of
-- 20 were never granted to service_role — only ops.alert_subscriptions
-- (0072) and ops.scheduled_exports (0071) have it, because those are the
-- only two ops.* objects this session's own migrations happened to create
-- WITH a service_role grant baked in. Every other ops.* object predates any
-- admin-context (no end-user session) caller ever existing, so nothing
-- surfaced this until lib/exports/scheduledExports.ts became the first one.
--
-- Concretely, this also means buildTargetsAuditReport
-- (ops.vw_monthly_fresh_disc_audit_lines) has the identical bug and would
-- fail the same way once exercised — not yet confirmed live at the time of
-- writing this migration, but the grant audit makes it certain, so fixed
-- here rather than waiting to rediscover it view-by-view.
--
-- Same blanket-grant shape as 0073's fix for `sales` (also all-views, no
-- new privilege escalation: service_role already bypasses RLS everywhere
-- else in this app's trust model — see lib/data/admin.ts's own header).
-- =============================================================================

grant select on all tables in schema ops to service_role;
alter default privileges in schema ops grant select on tables to service_role;

notify pgrst, 'reload schema';
