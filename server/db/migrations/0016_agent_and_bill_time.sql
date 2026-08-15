-- =============================================================================
-- 0016 · Agent name + bill time — new columns in the latest source export
-- =============================================================================
-- The latest Logic extract adds two columns the earlier one didn't have:
-- AGENT NAME ("003 - RUPALI SHIRSATH" — branch-code-prefixed, but not every
-- row follows that pattern, e.g. "NAVNATH SATHE" and "MANSA CLOTHING" have
-- none, so agent_name is stored as free text, not parsed into a code/name
-- pair) and BILL TIME ("05:58:00 PM" text, 12-hour with AM/PM). Also found
-- while profiling this file: 11 of 18,178 rows have a null NET AMOUNT with a
-- populated GROSS AMOUNT — handled by treating a null net as "no discount"
-- (coalesce to gross), not by dropping the row.

alter table raw_logic.sales_transactions
  add column if not exists agent_name text,
  add column if not exists bill_time  text;

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
  coalesce(st.net_amount, st.gross_amount)                        as net_amount,
  (st.gross_amount - coalesce(st.net_amount, st.gross_amount))     as discount_amount,
  nullif(trim(st.scheme_name), '')                                 as scheme_name,
  nullif(trim(st.scheme_group_name), '')                           as scheme_group_name,
  nullif(trim(st.agent_name), '')                                  as agent_name,
  parsed.bill_time_parsed                                          as bill_time
from raw_logic.sales_transactions st
  cross join lateral (
    select
      case
        when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$'
          then to_date(st.bill_date, 'DD/MM/YYYY')
        else st.bill_date::date
      end as branch_date,
      case
        when st.bill_time ~ '^\d{2}:\d{2}:\d{2} (AM|PM)$'
          then to_timestamp(st.bill_time, 'HH12:MI:SS AM')::time
        else null
      end as bill_time_parsed
  ) parsed
  join core.stores s on s.branch_name_erp = st.branch_name and s.is_active
where st.branch_name is not null
  and st.bill_no not in ('BRANCH WISE TOTALS', 'GRAND TOTALS')
  and s.store_id = any (core.fn_user_store_ids());

comment on view sales.vw_ebo_sales_lines is
  'Line grain: store x date x bill x item, plus agent_name and bill_time where the source provides them (both nullable — not every Logic export version has had these columns). security_invoker = OFF, deliberately — see 0015 for why.';
