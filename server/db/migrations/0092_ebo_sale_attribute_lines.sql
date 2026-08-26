-- =============================================================================
-- 0092 · sales.vw_ebo_sale_attribute_lines — store-scoped sale lines carrying
--        their own PRODUCT attributes, for /sales' Season+Year breakdown
-- =============================================================================
-- The /sales page's Phase 3 ask is a PRODUCT-attribute grouping ("how did the
-- Summer 2026 collection perform"), not a calendar grain — the same "View by"
-- attribute-combo mechanism Sale vs Stock Mix already has
-- (web/lib/replenishment/mixAttributes.ts), applied to Sale data.
--
-- Why a new view rather than reusing one of the two that already exist:
--
-- 1. sales.vw_ebo_sales_lines (0004/0014/0015/0036) is correctly store-scoped
--    (`s.store_id = any (core.fn_user_store_ids())`) but carries only ONE
--    product attribute — `category` (0036). No season / gender / size_group /
--    subcategory / market_segment / shade, so it cannot answer the question.
--    Not extended in place: every EBO rollup in the app
--    (vw_ebo_bill -> vw_ebo_sales_daily -> _weekly/_monthly) is built on top
--    of it, and appending columns to the base of that whole chain is a much
--    larger blast radius than one new leaf view for one new section.
--
-- 2. sales.vw_sale_transactions_export (0028/0085/0086) DOES carry season /
--    market_segment / gender / size_group / shade_name / mrp, but is
--    deliberately unscoped — its own comment says "Never expose this view to
--    non-admin roles without adding a row filter first. Access control is
--    entirely at the route layer (ho_admin/super_admin)." /sales is reachable
--    by ebo_manager and marketing (see SalesPage's requireRole list), i.e.
--    genuinely store-scoped users, so reading it there would put per-store
--    isolation on an app-level `.in("branch_name", ...)` filter instead of on
--    core.fn_user_store_ids(). That is exactly the mistake 0014/0015 already
--    walked back once on this same data. It also has no category/subcategory
--    at all, and sources its attributes from raw_logic.item_master (the value
--    NOW) rather than the sale line's own as-of-sale value.
--
-- Attribute source: raw_logic.sales_transactions' OWN attribute columns
-- (0030) first, with raw_logic.item_master (0054) as a per-column fallback
-- via coalesce. 0030's header explains why the line's own value is preferred
-- — it is the as-of-sale value, not "what is this item classified as today",
-- which differs for a re-classified or discontinued item. The item_master
-- fallback matters for two real gaps: rows loaded before 0030 added those
-- columns have them NULL, and the nightly sale_detail sync (0090) writes
-- shade_name/category/subcategory/season/market_segment/gender but has no
-- source for size_group or pack_size, so those would otherwise be NULL on
-- every current-FY synced row. Same "primary source, then fall back" shape
-- lib/replenishment/mix.ts already uses for item attributes (stock snapshot
-- first, sale row second).
--
-- Security posture: copied verbatim from sales.vw_ebo_sales_lines' own
-- resolution in 0015 — security_invoker = off (the view must reach
-- raw_logic.*, which authenticated has no grant on, and must not need one),
-- security_barrier = true (the planner must not push a caller's filter ahead
-- of this view's own WHERE), and the row filter itself is
-- `s.store_id = any (core.fn_user_store_ids())`, which depends only on
-- auth.uid() reading the request's JWT claims and so is correct regardless of
-- which role's privileges the view body executes under.
--
-- bill_type follows the 0036/0086 rule ('%SB-%' / '%RB-%' as a SUBSTRING, not
-- a prefix) so fiscal-year-prefixed bill numbers ("2526/3/SB-000001", per
-- [[project-bill-number-format]]) classify correctly.
--
-- Amount convention: net_amount/gross_amount/total_quantity are UNSIGNED
-- magnitudes here, exactly as stored, with bill_type carried alongside — the
-- same contract sales.vw_ebo_sales_lines exposes. This view does NOT
-- sign-adjust returns; sales.vw_ebo_sales_daily's own aggregation (0005)
-- sums them unsigned across bill types and reports returns_value separately,
-- and the consumer (web/lib/sales/attributeBreakdown.ts) reproduces that same
-- convention so an attribute breakdown reconciles against the page's own KPI
-- totals rather than disagreeing with them by twice the returns value.

create or replace view sales.vw_ebo_sale_attribute_lines
with (security_invoker = off, security_barrier = true) as
select
  s.store_id,
  parsed.branch_date                                               as bill_date,
  st.bill_no,
  case
    when st.bill_no like '%SB-%' then 'SALE'
    when st.bill_no like '%RB-%' then 'RETURN'
    else 'OTHER'
  end                                                              as bill_type,
  st.item_code,
  st.total_quantity,
  st.gross_amount,
  coalesce(st.net_amount, st.gross_amount)                         as net_amount,
  -- Line's own as-of-sale value (0030) first, item_master (0054) second.
  coalesce(nullif(trim(st.season), ''),         nullif(trim(im.season), ''))         as season,
  coalesce(nullif(trim(st.market_segment), ''), nullif(trim(im.market_segment), '')) as market_segment,
  coalesce(nullif(trim(st.category), ''),       nullif(trim(im.category), ''))       as category,
  coalesce(nullif(trim(st.subcategory), ''),    nullif(trim(im.subcategory), ''))    as subcategory,
  coalesce(nullif(trim(st.gender), ''),         nullif(trim(im.gender), ''))         as gender,
  coalesce(nullif(trim(st.size_group), ''),     nullif(trim(im.size_group), ''))     as size_group,
  coalesce(nullif(trim(st.shade_name), ''),     nullif(trim(im.shade_name), ''))     as shade_name,
  coalesce(nullif(trim(st.pack_size), ''),      nullif(trim(im.pack_size), ''))      as pack_size,
  coalesce(st.mrp, im.mrp)                                                           as mrp
from raw_logic.sales_transactions st
  cross join lateral (
    select case
      when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$'
        then to_date(st.bill_date, 'DD/MM/YYYY')
      else st.bill_date::date
    end as branch_date
  ) parsed
  join core.stores s on s.branch_name_erp = st.branch_name and s.is_active
  left join raw_logic.item_master im on im.item_code = st.item_code
where st.branch_name is not null
  and st.bill_no not in ('BRANCH WISE TOTALS', 'GRAND TOTALS')
  and s.store_id = any (core.fn_user_store_ids());

comment on view sales.vw_ebo_sale_attribute_lines is
  'Line grain: store x date x bill x item, carrying the PRODUCT attributes (season, market_segment, category, subcategory, gender, size_group, shade_name, pack_size, mrp) that sales.vw_ebo_sales_lines does not — for /sales'' product-attribute "View by" breakdown (0092). Each attribute is the sale line''s own as-of-sale value (raw_logic.sales_transactions, 0030) with raw_logic.item_master (0054) as a per-column fallback for rows predating 0030 and for size_group/pack_size, which the sale_detail sync (0090) has no source for. Amounts are UNSIGNED magnitudes with bill_type alongside, same contract as sales.vw_ebo_sales_lines — the consumer applies the SALE/RETURN treatment, this view does not. Store-scoped via core.fn_user_store_ids(); security_invoker = off + security_barrier = true for the reasons 0015 documents for sales.vw_ebo_sales_lines. Unlike sales.vw_sale_transactions_export, this view IS safe to expose to store-scoped roles (ebo_manager, marketing).';

grant select on sales.vw_ebo_sale_attribute_lines to authenticated;

notify pgrst, 'reload schema';
