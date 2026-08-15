-- =============================================================================
-- 0033 · Financial-year filtering for the merged sale export
-- =============================================================================
-- Adds a `financial_year` column to sales.vw_sale_transactions_export (0028)
-- so the "Download merged sale file" flow (now folded into the Sale report
-- section on the Data Upload page instead of a separate button — see
-- web/app/api/data-upload/download-merged/route.ts) can filter by one or
-- more fiscal years without pulling the full multi-year history into Node
-- and filtering there.
--
-- India FY convention (Apr-Mar), computed inline from bill_date rather than
-- joined against core.retail_calendar — the export view already casts
-- bill_date itself (see 0028), and retail_calendar only covers a pre-seeded
-- 2023-2028 window (0002's header), which would silently drop rows for any
-- bill_date outside that range. Label format matches the existing
-- core.retail_calendar.financial_year convention exactly: 'FY2026-27'.
--
-- Also adds sales.vw_sale_transactions_fiscal_years, a tiny DISTINCT-backed
-- view the Data Upload page reads to populate the fiscal-year multi-select
-- with whatever years actually have data today — never a hardcoded list.
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
  st.line_seq,
  case
    when extract(month from (case
      when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$' then to_date(st.bill_date, 'DD/MM/YYYY')
      else st.bill_date::date
    end)) >= 4
    then 'FY' || extract(year from (case
      when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$' then to_date(st.bill_date, 'DD/MM/YYYY')
      else st.bill_date::date
    end))::int
      || '-' || lpad(((extract(year from (case
        when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$' then to_date(st.bill_date, 'DD/MM/YYYY')
        else st.bill_date::date
      end))::int + 1) % 100)::text, 2, '0')
    else 'FY' || (extract(year from (case
      when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$' then to_date(st.bill_date, 'DD/MM/YYYY')
      else st.bill_date::date
    end))::int - 1)
      || '-' || lpad((extract(year from (case
        when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$' then to_date(st.bill_date, 'DD/MM/YYYY')
        else st.bill_date::date
      end))::int % 100)::text, 2, '0')
  end as financial_year
from raw_logic.sales_transactions st
  left join core.stores s on s.branch_name_erp = st.branch_name
where st.branch_name is not null
  and st.bill_no not in ('BRANCH WISE TOTALS', 'GRAND TOTALS');

comment on view sales.vw_sale_transactions_export is
  'Unfiltered (no store-scoping, no active-only join) read of the full merged raw_logic.sales_transactions history, for the HO-wide merged sale download (folded into the Sale report section, migration 0033). security_invoker = OFF, same reasoning as sales.vw_stock_with_scheme (0024) — access control is entirely at the route layer (ho_admin/super_admin), not in this view. financial_year (added 0033) is computed inline (Apr-Mar, e.g. FY2026-27), not joined from core.retail_calendar, so it never silently drops rows outside that table''s pre-seeded date window. Never expose this view to non-admin roles without adding a row filter first.';

grant select on sales.vw_sale_transactions_export to authenticated;

create or replace view sales.vw_sale_transactions_fiscal_years
with (security_invoker = off, security_barrier = true) as
select distinct financial_year
from sales.vw_sale_transactions_export
order by financial_year;

comment on view sales.vw_sale_transactions_fiscal_years is
  'Distinct fiscal years actually present in raw_logic.sales_transactions right now, for the Data Upload page''s fiscal-year multi-select — never a hardcoded list of years. Same access-control shape as sales.vw_sale_transactions_export: no row filter, gated at the route/page layer (ho_admin/super_admin).';

grant select on sales.vw_sale_transactions_fiscal_years to authenticated;
