-- =============================================================================
-- 0086 · Fix bill_type on sales.vw_sale_transactions_export (same bug 0036
--        already fixed on sales.vw_ebo_sales_lines, missed here)
-- =============================================================================
-- Discovered while debugging Sale vs Stock Mix's attribute-wise views
-- (0084/0085): totalSales computed as 0 even after fixing attribute
-- attribution and pagination, because EVERY row in this view classified as
-- bill_type = 'OTHER'.
--
-- Root cause: this view's bill_type CASE still used the ORIGINAL rule
-- left(bill_no, 2) = 'SB'/'RB' — correct only for the old bare-prefix format
-- ("SB-185"). Real bill numbers here are fiscal-year/branch-code-prefixed
-- ("2526/3/SB-000001", per [[project-bill-number-format]]), so
-- left(bill_no, 2) is always the fiscal-year digits ("25"), never 'SB'/'RB'
-- — every row silently fell through to 'OTHER'.
--
-- sales.vw_ebo_sales_lines already hit and fixed this exact bug in 0036
-- (2026, well before this session): `bill_no like '%SB-%'` / `'%RB-%'`,
-- substring rather than prefix, confirmed a strict superset that matches
-- both bill-number formats. This view (0028) was never updated to match —
-- it predates 0036 and nothing needed its bill_type to be correct until
-- lib/replenishment/mix.ts started reading it for Sale vs Stock Mix.
--
-- Impact beyond this feature: the "Download merged sale file" export (this
-- view's original and, until 0085, only consumer) has had a wrong/always-
-- 'OTHER' bill_type column for any bill_no in the new format. Nothing
-- downstream FILTERED on it before now, which is presumably why this went
-- unnoticed — but the exported column itself has been wrong.
--
-- Column position/type unchanged (bill_type stays where it is; this is a
-- CASE expression edit, not an added column) — no downstream reordering
-- concern the way 0084/0085 had.

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
  'Unfiltered (no store-scoping, no active-only join) read of the full merged raw_logic.sales_transactions history, for the HO-wide "Download merged sale file" export AND (0085) for Sale vs Stock Mix''s attribute-wise views. bill_type (0086) matches SB-/RB- as a SUBSTRING anywhere in bill_no, same fix sales.vw_ebo_sales_lines already applied in 0036 — this view had been left on the original left(bill_no,2) prefix-only rule, which silently classified every fiscal-year-prefixed bill_no ("2526/3/SB-000001") as OTHER. financial_year (0033) is computed inline (Apr-Mar, e.g. FY2026-27), not joined from core.retail_calendar, so it never silently drops rows outside that table''s pre-seeded date window. security_invoker = OFF, same reasoning as sales.vw_stock_with_scheme (0024) — access control is entirely at the route layer (ho_admin/super_admin), not in this view. Never expose this view to non-admin roles without adding a row filter first. This view has no exact `size` column (0085: item_master has no per-line size for a sale row — size_group is the finest grain available here); vw_stock_with_scheme is still the only source for exact size.';

grant select on sales.vw_sale_transactions_export to authenticated;

notify pgrst, 'reload schema';
