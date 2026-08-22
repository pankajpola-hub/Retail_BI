-- =============================================================================
-- 0075 · Fix: raw_logic.scheme_lookup was never granted to `authenticated`
--        (a real, pre-existing bug — not introduced by 0073/0074).
-- =============================================================================
-- Found while chasing 0073/0074's service_role grant gaps: triggering the
-- targets_audit scheduled export failed with "permission denied for table
-- scheme_lookup". ops.vw_monthly_fresh_disc_audit_lines LEFT JOINs
-- raw_logic.scheme_lookup directly and is declared `security_invoker=on`
-- (confirmed via pg_class.reloptions) — meaning, unlike a normal view, it
-- runs with the CALLER's own table privileges, not the view owner's. A
-- direct grant check confirmed `authenticated` has ZERO grants on ANY
-- raw_logic table, `scheme_lookup` included — so this view has likely been
-- failing with this exact error for every real end user hitting
-- /api/targets/monthly/audit-report (Targets page), independent of
-- anything built this session. 0073's header quotes 0067's documented
-- intent that raw_logic should have zero grants and sales.* views are "the
-- ONLY door in" — this view is the one legitimate exception that intent
-- didn't account for, since it's ops.*, not sales.*, and needs
-- scheme_lookup specifically for the Fresh/Discounted classification
-- toggle (core.app_settings 'fresh_disc_classification_source').
--
-- Deliberately narrow: only raw_logic.scheme_lookup, not a blanket
-- raw_logic grant — item_master/sales_transactions/stock_snapshot stay
-- exactly as locked down as 0067 intended; nothing else in raw_logic reads
-- from anywhere that needs this widened.
-- =============================================================================

grant select on raw_logic.scheme_lookup to authenticated;
grant select on raw_logic.scheme_lookup to service_role;

notify pgrst, 'reload schema';
