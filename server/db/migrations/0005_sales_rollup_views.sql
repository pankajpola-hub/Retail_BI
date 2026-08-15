-- =============================================================================
-- 0005 · Bill / daily / weekly / monthly analytical views
-- =============================================================================
-- These are the views the app actually queries. Each is store-filtered via
-- core.fn_user_store_ids() so an ebo_manager querying sales.vw_ebo_sales_daily
-- transparently gets only their own store's rows — no per-query WHERE needed
-- in application code, and no risk of forgetting it.

-- ---------------------------------------------------------------------------
-- Bill level. A bill can mix scheme groups (20 of 604 sample bills did) —
-- "dominant scheme group" = whichever scheme group sums to the largest net
-- contribution on that bill, chosen deterministically via DISTINCT ON, not
-- picked arbitrarily or by first-seen line.
-- ---------------------------------------------------------------------------
create or replace view sales.vw_ebo_bill
with (security_invoker = on) as
with bill_agg as (
  select
    store_id, bill_date, bill_no, bill_type,
    sum(total_quantity)                       as quantity,
    sum(gross_amount)                         as gross_amount,
    sum(net_amount)                           as net_amount,
    sum(discount_amount)                      as discount_amount,
    count(*)                                  as line_count,
    bool_or(scheme_name is not null)          as has_scheme,
    count(distinct scheme_group_name) filter (where scheme_group_name is not null) as scheme_group_count
  from sales.vw_ebo_sales_lines
  where store_id = any (core.fn_user_store_ids())
  group by store_id, bill_date, bill_no, bill_type
),
scheme_group_totals as (
  select store_id, bill_date, bill_no, scheme_group_name, sum(net_amount) as group_net
  from sales.vw_ebo_sales_lines
  where store_id = any (core.fn_user_store_ids())
    and scheme_group_name is not null
  group by store_id, bill_date, bill_no, scheme_group_name
),
dominant_scheme as (
  select distinct on (store_id, bill_date, bill_no)
    store_id, bill_date, bill_no,
    scheme_group_name as dominant_scheme_group
  from scheme_group_totals
  order by store_id, bill_date, bill_no, group_net desc
)
select
  a.store_id, a.bill_date, a.bill_no, a.bill_type,
  a.quantity, a.gross_amount, a.net_amount, a.discount_amount, a.line_count,
  a.has_scheme, a.scheme_group_count, d.dominant_scheme_group,
  false as campaign_flag  -- placeholder: set true once bill<->campaign attribution (Phase 3) is wired
from bill_agg a
left join dominant_scheme d using (store_id, bill_date, bill_no);

comment on view sales.vw_ebo_bill is
  'One row per bill (SALE or RETURN). scheme_group_count > 1 flags bills that mix scheme groups — dominant_scheme_group breaks the tie by net value, never silently first-wins.';

-- ---------------------------------------------------------------------------
-- Daily store performance — the grain every KPI card and diagnosis reads from.
--
-- Built off a store x calendar-day spine, not a plain GROUP BY on bills. A
-- day with zero bills (store closed, or just a dead Tuesday) still must
-- produce a row with net_sales = 0 — otherwise it's indistinguishable from a
-- day outside the loaded date range, and sales.vw_ebo_sales_weekly's
-- is_complete_week flag (below) would silently mislabel a week with a real
-- zero-sale day as "in progress" or vice versa.
-- ---------------------------------------------------------------------------
create or replace view sales.vw_ebo_sales_daily
with (security_invoker = on) as
with spine as (
  select s.store_id, rc.date as bill_date, rc.day_name, rc.week_start, rc.retail_week,
         rc.retail_year, rc.retail_month, rc.retail_quarter, rc.financial_year, rc.is_weekend
  from core.stores s
  -- coalesce(s.opened_date, rc.date) falls back to rc.date itself when a store
  -- has no opened_date on file, which collapses the lower bound away (rc.date
  -- between rc.date and current_date ≡ rc.date <= current_date) instead of
  -- excluding the store from the spine entirely.
  join core.retail_calendar rc
    on rc.date between coalesce(s.opened_date, rc.date) and current_date
  where s.is_active
    and s.store_id = any (core.fn_user_store_ids())
),
bill_totals as (
  select
    store_id, bill_date,
    count(*) filter (where bill_type = 'SALE')                          as sale_bills,
    count(*) filter (where bill_type = 'RETURN')                        as return_bills,
    sum(quantity)                                                       as net_quantity,
    sum(gross_amount)                                                   as gross_sales,
    sum(discount_amount)                                                as discount,
    sum(net_amount)                                                     as net_sales,
    sum(net_amount) filter (where bill_type = 'RETURN')                 as returns_value,
    sum(net_amount) filter (where bill_type = 'SALE')                   as sale_net_amount,
    sum(quantity) filter (where bill_type = 'SALE')                     as sale_quantity
  from sales.vw_ebo_bill
  group by store_id, bill_date
)
select
  spine.store_id, spine.bill_date, spine.day_name, spine.week_start, spine.retail_week,
  spine.retail_year, spine.retail_month, spine.retail_quarter, spine.financial_year, spine.is_weekend,
  coalesce(t.sale_bills, 0)          as sale_bills,
  coalesce(t.return_bills, 0)        as return_bills,
  coalesce(t.net_quantity, 0)        as net_quantity,
  coalesce(t.gross_sales, 0)         as gross_sales,
  coalesce(t.discount, 0)            as discount,
  coalesce(t.net_sales, 0)           as net_sales,
  coalesce(t.returns_value, 0)       as returns_value,
  round(t.sale_net_amount / nullif(t.sale_bills, 0), 2)                  as atv,
  round(t.sale_quantity / nullif(t.sale_bills, 0)::numeric, 3)           as upt,
  round(100.0 * coalesce(t.discount, 0) / nullif(t.gross_sales, 0), 2)   as discount_pct,
  coalesce(t.sale_quantity, 0)       as sale_quantity  -- appended last: CREATE OR REPLACE VIEW cannot reorder or insert columns mid-list, only append
from spine
left join bill_totals t using (store_id, bill_date);

comment on view sales.vw_ebo_sales_daily is
  'One row per store per calendar day, always — zero-sale days included with net_sales = 0 rather than simply absent. ATV/UPT stay NULL (not 0) on a zero-bill day, since dividing by zero bills is undefined, not a bad basket. Conversion is deliberately absent here; it lives in ops.vw_ebo_conversion_daily, which LEFT JOINs footfall and is NULL, not 0, on days with no footfall entry.';

-- ---------------------------------------------------------------------------
-- Retail-week rollup (Mon→Sun)
-- ---------------------------------------------------------------------------
create or replace view sales.vw_ebo_sales_weekly
with (security_invoker = on) as
select
  store_id, week_start, retail_week, retail_year,
  min(bill_date)                          as week_first_day_with_data,
  max(bill_date)                          as week_last_day_with_data,
  count(distinct bill_date)               as days_with_data,
  (max(bill_date) - min(week_start))::int >= 6                       as is_complete_week,
  sum(sale_bills)                         as sale_bills,
  sum(return_bills)                       as return_bills,
  sum(net_quantity)                       as net_quantity,
  sum(gross_sales)                        as gross_sales,
  sum(discount)                           as discount,
  sum(net_sales)                          as net_sales,
  round(sum(net_sales) / nullif(sum(sale_bills), 0), 2)                     as atv,
  round(100.0 * sum(discount) / nullif(sum(gross_sales), 0), 2)             as discount_pct,
  sum(sale_quantity)                                                       as sale_quantity,
  round(sum(sale_quantity) / nullif(sum(sale_bills), 0)::numeric, 3)        as upt
from sales.vw_ebo_sales_daily
group by store_id, week_start, retail_week, retail_year;

comment on view sales.vw_ebo_sales_weekly is
  'is_complete_week is false for the current in-progress week — the app must label it (e.g. "6 of 7 days") rather than compare it to a full prior week as if equivalent.';

-- ---------------------------------------------------------------------------
-- Monthly rollup
-- ---------------------------------------------------------------------------
create or replace view sales.vw_ebo_sales_monthly
with (security_invoker = on) as
select
  store_id,
  date_trunc('month', bill_date)::date    as month_start,
  retail_month, retail_quarter, retail_year, financial_year,
  sum(sale_bills)                         as sale_bills,
  sum(return_bills)                       as return_bills,
  sum(net_quantity)                       as net_quantity,
  sum(gross_sales)                        as gross_sales,
  sum(discount)                           as discount,
  sum(net_sales)                          as net_sales,
  round(sum(net_sales) / nullif(sum(sale_bills), 0), 2) as atv,
  round(100.0 * sum(discount) / nullif(sum(gross_sales), 0), 2) as discount_pct,
  sum(sale_quantity)                                                  as sale_quantity,
  round(sum(sale_quantity) / nullif(sum(sale_bills), 0)::numeric, 3)  as upt
from sales.vw_ebo_sales_daily
group by store_id, date_trunc('month', bill_date), retail_month, retail_quarter, retail_year, financial_year;

-- ---------------------------------------------------------------------------
-- Scheme / campaign-flag performance (Section 17 of the brief)
-- ---------------------------------------------------------------------------
create or replace view sales.vw_ebo_scheme_daily
with (security_invoker = on) as
select
  store_id, bill_date,
  coalesce(dominant_scheme_group, 'NO SCHEME')          as scheme_group,
  count(*) filter (where bill_type = 'SALE')             as bills,
  sum(quantity) filter (where bill_type = 'SALE')        as quantity,
  sum(gross_amount) filter (where bill_type = 'SALE')    as gross_sales,
  sum(discount_amount) filter (where bill_type = 'SALE') as discount,
  sum(net_amount) filter (where bill_type = 'SALE')      as net_sales
from sales.vw_ebo_bill
group by store_id, bill_date, coalesce(dominant_scheme_group, 'NO SCHEME');

grant select on sales.vw_ebo_bill, sales.vw_ebo_sales_daily, sales.vw_ebo_sales_weekly,
                 sales.vw_ebo_sales_monthly, sales.vw_ebo_scheme_daily
  to authenticated;
