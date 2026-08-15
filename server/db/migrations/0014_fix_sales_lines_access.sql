-- =============================================================================
-- 0014 · Fix sales.vw_ebo_sales_lines being unreachable through its own
--        downstream views
-- =============================================================================
-- 0004 revoked all authenticated/anon access to this view on the theory
-- that it was "only reachable through the store-filtered views in 0005" —
-- that reasoning was wrong. Every view from here up through
-- vw_ebo_sales_weekly/_monthly is declared WITH (security_invoker = on),
-- which means the CALLING USER's own privileges are checked at every layer
-- of the chain, not just the outermost one. Revoking this view didn't
-- protect it — it broke every view built on top of it for every real user,
-- surfaced when the first real query through the full chain
-- (sales.vw_ebo_sales_weekly, from the network dashboard) returned
-- "permission denied for view vw_ebo_sales_lines".
--
-- The actual fix has two parts:
--   1. This view never filtered by store access itself — it only filtered
--      to branches present in core.stores (the WAREHOUSE/OFFICE channel
--      exclusion from 0004), not to which stores THIS caller may see. That
--      was fine when nothing could query it directly. Now that grants allow
--      direct queries, it needs its own core.fn_user_store_ids() filter —
--      redundant with vw_ebo_bill's filter one layer up, but correct: an
--      ebo_manager scoped to one store must not be able to read another
--      store's lines by querying this view directly instead of going
--      through the rollups.
--   2. Grant SELECT to authenticated now that the view enforces that scope
--      itself.

create or replace view sales.vw_ebo_sales_lines
with (security_invoker = on) as
select
  s.store_id,
  parsed.branch_date                                              as bill_date,
  st.bill_no,
  case
    when left(st.bill_no, 2) = 'SB' then 'SALE'
    when left(st.bill_no, 2) = 'RB' then 'RETURN'
    else 'OTHER'
  end                                                              as bill_type,
  st.item_code,
  st.total_quantity,
  st.gross_amount,
  st.net_amount,
  (st.gross_amount - st.net_amount)                                as discount_amount,
  nullif(trim(st.scheme_name), '')                                 as scheme_name,
  nullif(trim(st.scheme_group_name), '')                           as scheme_group_name
from raw_logic.sales_transactions st
  cross join lateral (
    select case
      when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$'
        then to_date(st.bill_date, 'DD/MM/YYYY')
      else st.bill_date::date
    end as branch_date
  ) parsed
  join core.stores s on s.branch_name_erp = st.branch_name and s.is_active
where st.branch_name is not null
  and st.bill_no not in ('BRANCH WISE TOTALS', 'GRAND TOTALS')
  and s.store_id = any (core.fn_user_store_ids());

comment on view sales.vw_ebo_sales_lines is
  'Line grain: store x date x bill x item. Filters to the caller''s accessible stores directly (core.fn_user_store_ids()) — do not assume downstream views provide this protection; with security_invoker = on throughout the chain, every view must be safe to query on its own.';

grant select on sales.vw_ebo_sales_lines to authenticated;
