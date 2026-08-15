-- =============================================================================
-- 0028 · sales.vw_sale_transactions_export — HO-wide merged sale download
-- =============================================================================
-- Backs the "Download merged sale file" button on the Data Upload page: a
-- single Excel export of the FULL accumulated raw_logic.sales_transactions
-- history (all fiscal years' Sale-report uploads merged, deduplicated by the
-- existing (branch_name, bill_date, bill_no, item_code, line_seq) natural
-- key from migration 0024 — the table itself is already the merged/dedup'd
-- source of truth, so this view is a thin read, not a new merge step).
--
-- Deliberately NOT the same view as sales.vw_ebo_sales_lines (0004/0014/0015):
-- that view scopes rows to `core.fn_user_store_ids()` for the logged-in
-- user's own store(s) and inner-joins core.stores, silently dropping any
-- branch_name that doesn't map to an active store (e.g. WAREHOUSE-*/OFFICE-*
-- channels). The merged download is HO Admin/Super Admin only and needs
-- every row that ever landed in raw_logic.sales_transactions, unfiltered —
-- same access-control shape as sales.vw_stock_with_scheme (0024): no
-- row-level filter in the view itself, gate enforced entirely at the route
-- layer (see web/app/api/data-upload/download-merged/route.ts, which checks
-- core.profiles.role the same way web/app/api/targets/monthly/audit-report
-- already does for its own admin-only Excel export).
create or replace view sales.vw_sale_transactions_export
with (security_invoker = off, security_barrier = true) as
select
  st.branch_name,
  s.store_name,
  case
    when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$' then to_date(st.bill_date, 'DD/MM/YYYY')
    else st.bill_date::date
  end as bill_date,
  st.bill_no,
  case
    when left(st.bill_no, 2) = 'SB' then 'SALE'
    when left(st.bill_no, 2) = 'RB' then 'RETURN'
    else 'OTHER'
  end as bill_type,
  st.item_code,
  st.total_quantity,
  st.gross_amount,
  st.net_amount,
  (st.gross_amount - st.net_amount) as discount_amount,
  st.agent_name,
  nullif(trim(st.scheme_name), '') as scheme_name,
  nullif(trim(st.scheme_group_name), '') as scheme_group_name,
  st.bill_time,
  st.line_seq
from raw_logic.sales_transactions st
  left join core.stores s on s.branch_name_erp = st.branch_name
where st.branch_name is not null
  and st.bill_no not in ('BRANCH WISE TOTALS', 'GRAND TOTALS');

comment on view sales.vw_sale_transactions_export is
  'Unfiltered (no store-scoping, no active-only join) read of the full merged raw_logic.sales_transactions history, for the HO-wide "Download merged sale file" export. security_invoker = OFF, same reasoning as sales.vw_stock_with_scheme (0024) — access control is entirely at the route layer (ho_admin/super_admin), not in this view. Never expose this view to non-admin roles without adding a row filter first.';

grant select on sales.vw_sale_transactions_export to authenticated;
