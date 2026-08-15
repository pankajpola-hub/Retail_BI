-- =============================================================================
-- 0039 · Category filter option list: stop hiding ACCESSORIES
-- =============================================================================
-- 0037 removed the automatic accessory exclusion from the Subcategory option
-- list and the tracker's totals, but missed this sibling view — Category
-- (0030/0032) is a separate real column on raw_logic.sales_transactions
-- (values: 'APPAREL', 'ACCESSORIES'), not derived from Subcategory, and had
-- its own hardcoded `category <> 'ACCESSORIES'` exclusion that 0037 didn't
-- touch. Verified against real data: 560 real sale lines are tagged
-- category = 'ACCESSORIES'. Same fix as 0037: no automatic exclusion
-- anywhere in the option lists — what counts is entirely up to what the
-- user selects.
create or replace view sales.vw_sale_category_options
with (security_invoker = on) as
select distinct category
from sales.vw_ebo_sales_lines
where category is not null
order by category;

grant select on sales.vw_sale_category_options to authenticated;
