-- =============================================================================
-- 0085 · Join item_master onto sales.vw_sale_transactions_export
-- =============================================================================
-- Fixes a real bug in the Sale vs Stock Mix attribute-wise views (Color/
-- Size/Gender/Season+Year/MRP Range, shipped in 0084): most sold items
-- landed in an "unclassified" (—) group carrying nearly all the sales,
-- even though the customer HAD uploaded item_master with full attribute
-- coverage.
--
-- Root cause: lib/replenishment/mix.ts only read attributes off
-- sales.vw_stock_with_scheme (0056), which joins item_master onto the STOCK
-- SNAPSHOT. An item that has fully sold through — closing_stock is 0/absent
-- from the current snapshot — never appears in that view at all, so its
-- attributes were unreachable no matter how complete item_master was.
-- Confirmed live: of a 1000-row sale sample, 950 rows' item_codes did not
-- exist anywhere in vw_stock_with_scheme.
--
-- Fix: join item_master directly onto the SALE rows too, the same way 0056
-- already does for stock rows, so a sale row carries its own attributes
-- independent of whether that item still has stock anywhere. New columns
-- appended at the end (Postgres forbids reordering/renaming an existing
-- view's output columns under CREATE OR REPLACE VIEW) — every existing
-- column, position, and consumer (the Data Upload "Download merged sale
-- file" export) is unaffected.

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
  end as financial_year,
  im.item_name,
  im.shade_name,
  im.season,
  im.market_segment,
  im.gender,
  im.size_group,
  im.mrp
from raw_logic.sales_transactions st
  left join core.stores s on s.branch_name_erp = st.branch_name
  left join raw_logic.item_master im on im.item_code = st.item_code
where st.branch_name is not null
  and st.bill_no not in ('BRANCH WISE TOTALS', 'GRAND TOTALS');

comment on view sales.vw_sale_transactions_export is
  'Unfiltered (no store-scoping, no active-only join) read of the full merged raw_logic.sales_transactions history, for the HO-wide "Download merged sale file" export AND (0085) for Sale vs Stock Mix''s attribute-wise views, which need a sale row''s attributes independent of whether that item_code still has any stock (sales.vw_stock_with_scheme''s item_master join only reaches items present in the current stock snapshot). financial_year (0033) is computed inline (Apr-Mar, e.g. FY2026-27), not joined from core.retail_calendar, so it never silently drops rows outside that table''s pre-seeded date window. security_invoker = OFF, same reasoning as sales.vw_stock_with_scheme (0024) — access control is entirely at the route layer (ho_admin/super_admin), not in this view. Never expose this view to non-admin roles without adding a row filter first. This view has no exact `size` column (0085: item_master has no per-line size for a sale row — size_group is the finest grain available here); vw_stock_with_scheme is still the only source for exact size.';

grant select on sales.vw_sale_transactions_export to authenticated;

notify pgrst, 'reload schema';
