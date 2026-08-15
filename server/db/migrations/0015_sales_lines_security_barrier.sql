-- =============================================================================
-- 0015 · sales.vw_ebo_sales_lines must NOT be security_invoker
-- =============================================================================
-- 0014's fix was half right and broke one layer deeper: with
-- security_invoker = on, Postgres checks the CALLER's privileges against
-- every object the view touches — including raw_logic.sales_transactions
-- itself. The error from testing 0014 literally suggested
-- `GRANT SELECT ON raw_logic.sales_transactions TO authenticated`, which
-- would have defeated the entire point of 0001's
-- `revoke all on schema raw_logic from anon, authenticated` — any
-- authenticated user could then query the raw ERP table directly, bypassing
-- the branch filter that excludes WAREHOUSE-*/OFFICE-* channels, and
-- bypassing per-store scoping entirely.
--
-- This is the one view in the whole sales.* chain that should run as a
-- classic Postgres "security barrier" view instead: it executes with the
-- VIEW OWNER's privileges (who has legitimate access to raw_logic), not the
-- caller's. That does NOT reopen the per-user store leak, because the
-- row-filtering `where s.store_id = any(core.fn_user_store_ids())` depends
-- only on auth.uid() reading the request's JWT claims — that works
-- correctly regardless of which role's privileges the view executes under.
-- Every other view in sales.*/ops.*/marketing.* keeps security_invoker = on
-- as before; they only ever query THIS view (which they have a grant on),
-- never raw_logic directly, so they need no change.
--
-- security_barrier = true additionally stops the query planner from
-- evaluating caller-supplied filter conditions before this view's own WHERE
-- clause — the standard hardening for a view whose entire job is
-- restricting rows, not just convenience.

create or replace view sales.vw_ebo_sales_lines
with (security_invoker = off, security_barrier = true) as
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
  'Line grain: store x date x bill x item. security_invoker = OFF, deliberately — this is the one view in the chain allowed to run as its owner so callers never need direct raw_logic privileges. Safe only because the store-scoping WHERE clause depends on auth.uid() (JWT-derived), not on privilege context. Every other sales.*/ops.*/marketing.* view keeps security_invoker = on and must never touch raw_logic directly — always go through this view.';

-- raw_logic stays locked down exactly as 0001 set it — nothing granted here.
