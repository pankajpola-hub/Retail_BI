-- =============================================================================
-- 0041 · sales.vw_sale_transactions_export — same bill_type fix as 0036
-- =============================================================================
-- 0036 fixed sales.vw_ebo_sales_lines's bill_type from a prefix-only match
-- (left(bill_no,2)='SB'/'RB') to a substring match ('%SB-%'/'%RB-%'), because
-- the newer Sale report format prefixes bill_no with a fiscal-year/month tag
-- ("2425/10/SB-00733" vs the old bare "SB-185"), and every new-format row was
-- falling through to 'OTHER'. sales.vw_sale_transactions_export has its OWN
-- independent bill_type expression (most recently redefined by 0033, which
-- added financial_year as a trailing column) and was never given the same
-- fix — discovered 2026-08 while building the Replenishment page, whose
-- sales-velocity calc filters on bill_type = 'SALE'/'RETURN' and was
-- silently computing zero demand for every SKU because every row classified
-- as 'OTHER'. This also means the "Download merged sale file" export's Bill
-- Type column has been wrong for every new-format row since 0036 shipped.
--
-- Column list/order here MUST exactly match 0033's (financial_year last) —
-- CREATE OR REPLACE VIEW cannot drop or reorder columns, and
-- sales.vw_sale_transactions_fiscal_years (0033) selects DISTINCT
-- financial_year FROM this view, so removing it breaks that view too. First
-- attempt at this migration used 0028's older column list (no
-- financial_year) and failed with "cannot drop columns from view" — this is
-- the corrected version.
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
    when st.bill_no like '%SB-%' then 'SALE'
    when st.bill_no like '%RB-%' then 'RETURN'
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
  'Unfiltered (no store-scoping, no active-only join) read of the full merged raw_logic.sales_transactions history, for the HO-wide merged sale download and the Replenishment page''s sales-velocity calc. bill_type (0041, matching 0036''s fix on vw_ebo_sales_lines) matches SB-/RB- as a substring anywhere in bill_no, not just as a prefix. financial_year (0033) computed inline, Apr-Mar. security_invoker = OFF — access control is entirely at the route layer (ho_admin/super_admin), not in this view. Never expose this view to non-admin roles without adding a row filter first.';

grant select on sales.vw_sale_transactions_export to authenticated;
