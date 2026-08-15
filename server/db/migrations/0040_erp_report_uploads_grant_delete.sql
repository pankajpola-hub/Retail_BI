-- =============================================================================
-- 0040 · ops.erp_report_uploads — grant DELETE
-- =============================================================================
-- 0022's RLS policy (erp_report_uploads_rw, `for all`) already covers DELETE
-- for ho_admin/super_admin, but the table-level GRANT never included it —
-- only select/insert/update. Needed now that Data Upload keeps only the
-- latest file per report type: a fresh upload deletes the older row(s) for
-- that report_type, which requires an actual DELETE grant, not just an RLS
-- policy that would allow it.

grant delete on ops.erp_report_uploads to authenticated;
