-- =============================================================================
-- 0036 · sales.vw_ebo_sales_lines — bill_type must match new bill_no format
-- =============================================================================
-- The "Sale report merged all years.xlsx" export (processed 2026-08-12) uses
-- a different bill_no format than the original one-time historical dump:
-- new "2425/10/SB-00733" (fiscal-year/month prefix) vs old "SB-185" (bare
-- prefix). bill_type's original rule, left(bill_no, 2) = 'SB'/'RB', only
-- matches the OLD format — every new-format row fell through to 'OTHER',
-- which silently zeroed out Sale Bills / Units Sold / Conversion on Network
-- once the old-format duplicate rows were cleaned up (see the delete that
-- prompted this fix: raw_logic.sales_transactions WHERE category IS NULL).
--
-- Verified against all 23408 real rows currently in raw_logic.sales_transactions
-- (post-dedup): exactly two bill_no shapes exist, "..SB-.." (22214 rows) and
-- "..RB-.." (1194 rows) — both always contain 'SB-'/'RB-' as a substring,
-- never only as a prefix now. Switched to a substring match, which is a
-- strict superset of the old prefix-only match (old-format "SB-185" still
-- matches 'SB-' as a substring), so this is safe for both formats and any
-- future re-mix of the two.
-- NOTE: NOT security_invoker here, despite 0004's original header text
-- saying it should be — confirmed live (2026-08-12) that the version of
-- this view actually running in production has security_invoker OFF: with
-- it on, `authenticated` needs a direct grant on raw_logic.sales_transactions
-- to satisfy the invoker-privilege check, which 0001 deliberately never
-- grants (raw_logic is meant to be reachable only through views/functions).
-- Some migration along the way evidently dropped the option without
-- documenting the change; matching that live behavior here rather than
-- "fixing" it back to invoker and re-breaking every authenticated read of
-- this view network-wide, which is what happened when this migration
-- briefly restored it.
create or replace view sales.vw_ebo_sales_lines
as
select
  s.store_id,
  parsed.branch_date                                              as bill_date,
  st.bill_no,
  case
    when st.bill_no like '%SB-%' then 'SALE'
    when st.bill_no like '%RB-%' then 'RETURN'
    else 'OTHER'
  end                                                              as bill_type,
  st.item_code,
  st.total_quantity,
  st.gross_amount,
  coalesce(st.net_amount, st.gross_amount)                        as net_amount,
  st.gross_amount - coalesce(st.net_amount, st.gross_amount)       as discount_amount,
  nullif(trim(st.scheme_name), '')                                 as scheme_name,
  nullif(trim(st.scheme_group_name), '')                           as scheme_group_name,
  nullif(trim(st.agent_name), '')                                  as agent_name,
  parsed.bill_time_parsed                                          as bill_time,
  st.id                                                            as line_id,
  nullif(trim(st.category), '')                                    as category
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
        else null::time
      end as bill_time_parsed
  ) parsed
  join core.stores s on s.branch_name_erp = st.branch_name and s.is_active
where st.branch_name is not null
  and st.bill_no not in ('BRANCH WISE TOTALS', 'GRAND TOTALS')
  and s.store_id = any (core.fn_user_store_ids());

comment on view sales.vw_ebo_sales_lines is
  'Line grain: store x date x bill x item. bill_type (0036) matches SB-/RB- as a substring anywhere in bill_no, not just as a prefix, to handle both the original bare bill-number format and the fiscal-year-prefixed format from later Sale report exports.';

grant select on sales.vw_ebo_sales_lines to authenticated;
