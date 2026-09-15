-- =============================================================================
-- 0105 · Fix sales.vw_channel_sales_summary — 0104's CREATE OR REPLACE VIEW failed
-- =============================================================================
-- 0104's view replacement interleaved the new columns (branch_name_og right
-- after branch_name, bill_week/week_dates/week_start/week_end right after
-- bill_month) instead of appending them at the end. Postgres only permits
-- CREATE OR REPLACE VIEW when every EXISTING column keeps its name AND
-- POSITION — new columns may only be added at the end (the exact rule
-- migration 0103's own header documents for vw_ebo_sale_attribute_lines,
-- missed here). The real error, confirmed by running 0104's statement
-- directly: `cannot change name of view column "bill_month" to
-- "branch_name_og"`.
--
-- 0104 has no explicit transaction wrapper, so every statement before this
-- one in that file (TRUNCATE, the two ALTER TABLEs, the constraint swap, the
-- new index, CREATE OR REPLACE FUNCTION) already committed independently and
-- is NOT re-run here — only the view, which is the one statement that
-- failed and stopped the script (psql -v ON_ERROR_STOP=1).
-- =============================================================================

create or replace view sales.vw_channel_sales_summary as
select
  id, branch_name, bill_month, party_name, channel_name, channel_type, channel_model,
  total_quantity, gross_amount, net_amount, created_at, updated_at,
  branch_name_og, bill_week, week_dates, week_start, week_end
from raw_logic.channel_sales_summary
where core.fn_user_role() in ('ho_admin', 'regional_manager', 'super_admin');

comment on view sales.vw_channel_sales_summary is
  'Read path for /sale-summary (HQ-only wholesale/distribution-channel view). Week grain since 0104 (fixed in 0105 — new columns appended at the end, not interleaved, per the view-replace column-position rule). Role-gated directly (core.fn_user_role() in ho_admin/regional_manager/super_admin) rather than relying on the route layer alone — see C-09 (migration 0097). security_invoker left at its default OFF — see raw_logic.channel_sales_summary''s own comment.';

notify pgrst, 'reload schema';
