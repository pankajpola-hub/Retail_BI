-- =============================================================================
-- 0103 · sales.vw_ebo_sale_attribute_lines — add agent_name, bill_time, size,
--        scheme_group_name and the retail calendar
-- =============================================================================
-- 0092 created this view as the store-scoped, line-grain, PRODUCT-attribute
-- carrying source for /sales' Season+Year breakdown. It is now being promoted
-- to the SINGLE line-grain source for a much larger slice of /sales: the new
-- attribute-filterable shared block (hourly chart, store league, scheme
-- penetration) and the three independent per-table mini-dashboards (period,
-- agent-wise, product attribute).
--
-- Two of those displays need axes 0092 did not carry:
--
--   * Hour of day — the hourly chart currently reads sales.vw_ebo_sales_hourly,
--     a pre-aggregated rollup with no product attributes on it at all, so it
--     cannot be narrowed by Category/Season/Colour/etc. Bucketing by hour off
--     the line itself is the only way to filter that chart by attribute.
--   * Agent — likewise, sales.vw_ebo_agent_daily is agent x date and carries no
--     product attributes.
--
-- A third column, `size`, is added for the same consumer: the new attribute
-- filter bar offers Size as one of its eight facets, and 0092 carried
-- size_group and pack_size but never `size` itself, so that filter could not
-- be built at all against this view. See its own note at the select item — it
-- is the one attribute here with no as-of-sale fallback available.
--
-- Both columns are derived EXACTLY as sales.vw_ebo_sales_lines (0004/0014/
-- 0015/0036) already derives them, copied rather than re-invented:
--
--   agent_name  nullif(trim(st.agent_name), '')
--   bill_time   case when st.bill_time ~ '^\d{1,2}:\d{2}:\d{2} (AM|PM)$'
--                 then to_timestamp(st.bill_time, 'HH12:MI:SS AM')::time
--                 else null end
--
-- raw_logic.sales_transactions.bill_time is TEXT, and the regex guard is
-- load-bearing, not defensive decoration: a bare to_timestamp() over the whole
-- column throws on any row whose time is blank or in another shape, which would
-- take the entire view down rather than leaving one row's hour unknown. Rows
-- that fail the guard get a NULL bill_time and are simply not placed on the
-- hourly chart — the same treatment vw_ebo_sales_lines has always given them.
--
-- Shape of the change: `create or replace view` with the two new columns
-- APPENDED at the end. Postgres permits create-or-replace on a view only if
-- the existing columns keep their names, types and ORDER, and new ones are
-- added at the end — which is exactly what this does, so no drop/recreate and
-- no dependent-object breakage. The only body change besides the two new select
-- items is the cross join lateral gaining a second computed column; its
-- branch_date expression is untouched.
--
-- Everything else 0092 established is deliberately unchanged and still applies:
-- the attribute coalesce chain (sale line's own as-of-sale value first,
-- raw_logic.item_master second), the '%SB-%' / '%RB-%' SUBSTRING bill_type rule
-- for fiscal-year-prefixed bill numbers, the UNSIGNED-magnitude amount contract
-- with bill_type carried alongside (the consumer applies SALE/RETURN treatment,
-- this view does not), and the security posture — security_invoker = off,
-- security_barrier = true, row filter s.store_id = any (core.fn_user_store_ids()).
-- Adding agent_name and bill_time widens what the view exposes about a row the
-- caller could already see; it does NOT widen WHICH rows the caller can see.

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
  coalesce(st.mrp, im.mrp)                                                           as mrp,
  -- 0103, appended. Same derivation as sales.vw_ebo_sales_lines — agent_name
  -- is the sale line's own value only (item_master has no agent axis, so there
  -- is nothing to coalesce against, unlike the product attributes above).
  nullif(trim(st.agent_name), '')                                  as agent_name,
  parsed.bill_time_parsed                                          as bill_time,
  -- 0103, appended. UNLIKE every product attribute above, `size` has NO
  -- coalesce chain: raw_logic.sales_transactions has no size column at all
  -- (0030 added shade_name/size_group/pack_size but not size; `size` arrived
  -- later, on item_master only, in 0087). So this is necessarily the value
  -- NOW rather than the as-of-sale value — the one attribute here that cannot
  -- honour 0092's "line's own value first" rule, because there is no line
  -- value to prefer. Stated rather than silently coalesced to look uniform.
  nullif(trim(im.size), '')                                        as size,
  -- 0103, appended. Scheme penetration is a BILL-grain idea: sales.vw_ebo_bill
  -- picks each bill's `dominant_scheme_group` as the scheme_group_name with the
  -- largest summed net_amount on that bill, and sales.vw_ebo_scheme_daily then
  -- rolls bills up by it. Neither view carries a product attribute, so that
  -- display cannot be attribute-filtered from them. Carrying the line's own
  -- scheme group here lets the consumer reproduce exactly that dominant-by-net
  -- rule over whichever lines survive the attribute filter. Same
  -- nullif(trim(...)) derivation as sales.vw_ebo_sales_lines.
  -- scheme_name (the individual scheme) is deliberately NOT carried: only the
  -- GROUP participates in the dominant-scheme rule and in the penetration
  -- figure, so adding it would widen the view for nothing.
  nullif(trim(st.scheme_group_name), '')                           as scheme_group_name,
  -- 0103, appended. The retail calendar, carried onto the line.
  --
  -- The Daily/Weekly/Monthly/Yearly period table is built by
  -- lib/sales/aggregate.ts's buildWeekSeries / buildMonthlyPeriodSeries /
  -- buildYearlyPeriodSeries, which need week_start, retail_week,
  -- financial_year and month_start. Those are RETAIL calendar values, not
  -- derivable from a date in JS: a retail week is not an ISO week and a
  -- financial year is not a calendar year. core.retail_calendar is the single
  -- definition of that mapping, and sales.vw_ebo_sales_daily already gets
  -- these columns by joining it. Carrying them here is what lets the period
  -- table read this view — and so be attribute-filterable — instead of
  -- re-implementing the retail calendar in the browser and letting the two
  -- definitions drift.
  --
  -- LEFT join: a bill dated outside the calendar's range must still appear in
  -- the line-level figures with a null period, never be silently dropped from
  -- sales because the calendar has not been extended yet.
  rc.day_name                                                      as day_name,
  rc.week_start                                                    as week_start,
  rc.retail_week                                                   as retail_week,
  rc.retail_year                                                   as retail_year,
  rc.retail_month                                                  as retail_month,
  rc.retail_quarter                                                as retail_quarter,
  rc.financial_year                                                as financial_year,
  rc.month_start                                                   as month_start,
  rc.is_weekend                                                    as is_weekend
from raw_logic.sales_transactions st
  cross join lateral (
    select
      case
        when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$'
          then to_date(st.bill_date, 'DD/MM/YYYY')
        else st.bill_date::date
      end as branch_date,
      -- Guarded parse, copied from vw_ebo_sales_lines: an unguarded
      -- to_timestamp() over this TEXT column throws on a blank or
      -- differently-shaped time and would fail the whole view.
      case
        when st.bill_time ~ '^\d{1,2}:\d{2}:\d{2} (AM|PM)$'
          then to_timestamp(st.bill_time, 'HH12:MI:SS AM')::time
        else null::time
      end as bill_time_parsed
  ) parsed
  join core.stores s on s.branch_name_erp = st.branch_name and s.is_active
  left join raw_logic.item_master im on im.item_code = st.item_code
  left join core.retail_calendar rc on rc.date = parsed.branch_date
where st.branch_name is not null
  and st.bill_no not in ('BRANCH WISE TOTALS', 'GRAND TOTALS')
  and s.store_id = any (core.fn_user_store_ids());

comment on view sales.vw_ebo_sale_attribute_lines is
  'Line grain: store x date x bill x item. The single store-scoped, line-level source for /sales'' EBO analysis — it carries the PRODUCT attributes (season, market_segment, category, subcategory, gender, size_group, shade_name, pack_size, mrp) that sales.vw_ebo_sales_lines does not, plus agent_name, a parsed bill_time, size and scheme_group_name (0103) so agent-wise and hour-of-day displays can be narrowed by those same product attributes, which the pre-aggregated vw_ebo_agent_daily / vw_ebo_sales_hourly rollups cannot be. Each product attribute is the sale line''s own as-of-sale value (raw_logic.sales_transactions, 0030) with raw_logic.item_master (0054) as a per-column fallback for rows predating 0030 and for size_group/pack_size, which the sale_detail sync (0090) has no source for. agent_name is the line''s own value only. size comes from raw_logic.item_master ALONE and is therefore the value NOW, not the as-of-sale value — raw_logic.sales_transactions has no size column to prefer (0030 added shade_name/size_group/pack_size but not size; size arrived on item_master in 0087). bill_time is NULL for any row whose text time does not match the HH:MI:SS AM/PM shape — such rows are simply not placed on an hour-of-day axis, same as in vw_ebo_sales_lines. Amounts are UNSIGNED magnitudes with bill_type alongside, same contract as sales.vw_ebo_sales_lines — the consumer applies the SALE/RETURN treatment, this view does not. Store-scoped via core.fn_user_store_ids(); security_invoker = off + security_barrier = true for the reasons 0015 documents for sales.vw_ebo_sales_lines. Unlike sales.vw_sale_transactions_export, this view IS safe to expose to store-scoped roles (ebo_manager, marketing).';

grant select on sales.vw_ebo_sale_attribute_lines to authenticated;

notify pgrst, 'reload schema';
