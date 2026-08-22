-- =============================================================================
-- 0067 · sales.vw_ecomm_* — semantic layer over raw_uniware
-- =============================================================================
-- Same role sales.vw_ebo_sales_lines (0004/0036) plays for Retail: the one
-- place raw ingest data becomes something a dashboard can query directly.
-- raw_uniware has zero grants to authenticated (0063's header — same posture
-- as raw_logic), so these views are the ONLY door in, same mechanism as the
-- Retail side.
--
-- Scoping: business_unit (0061), not store_id — a caller either has 'ecomm'
-- granted (core.fn_user_business_units()) or every row here is invisible to
-- them, no partial/row-level narrowing the way store_id narrows Retail rows.
-- The filter lives ONCE, in the two base views below; every rollup built on
-- top inherits it automatically by selecting FROM them, not raw_uniware
-- directly.
--
-- IMPORTANT, and unlike Retail: line-item revenue here is ASYNCHRONOUSLY
-- COMPLETE, not synchronously loaded. raw_uniware.sale_orders.items_synced_at
-- is null until the sync job's rate-limited enrichment pass (150 orders/run)
-- reaches that order — see 0063's header. A freshly-backfilled window can
-- have thousands of orders with zero line items for hours/days. Two things
-- follow: (1) sales.vw_ecomm_orders (header-only) is ALWAYS complete and is
-- the right source for "how many orders" questions; (2) every revenue rollup
-- below carries a `revenue_incomplete` flag — true whenever some orders in
-- that row aren't enriched yet — so the UI can (and must) show "(partial)"
-- rather than presenting an understated total as final.

-- -----------------------------------------------------------------------------
-- Order headers — always complete, no dependency on item enrichment
-- -----------------------------------------------------------------------------
create or replace view sales.vw_ecomm_orders as
select
  o.code                          as order_code,
  o.display_order_code,
  o.channel,
  o.status,
  o.order_datetime,
  o.order_datetime::date          as order_date,
  (o.items_synced_at is not null) as items_enriched
from raw_uniware.sale_orders o
where 'ecomm' = any (core.fn_user_business_units());

comment on view sales.vw_ecomm_orders is
  'One row per Uniware order, header-level only — always complete regardless of item-enrichment progress. Use this for order counts; use sales.vw_ecomm_order_lines (or the daily/monthly rollups) for revenue, and check revenue_incomplete there.';

revoke all on sales.vw_ecomm_orders from anon;
grant select on sales.vw_ecomm_orders to authenticated;

-- -----------------------------------------------------------------------------
-- Line items — grain: order x item. Only orders past enrichment appear here.
-- -----------------------------------------------------------------------------
create or replace view sales.vw_ecomm_order_lines as
select
  o.code                 as order_code,
  o.display_order_code,
  o.channel,
  o.status,
  o.order_datetime,
  o.order_datetime::date as order_date,
  i.item_sku,
  i.item_name             as style,     -- same naming choice as raw_logic.sales_transactions/item_master: "style", not a free-text product name
  i.size,
  i.color,
  i.brand,
  i.selling_price,
  i.total_price,
  i.mrp,
  i.discount,
  i.facility_code,
  i.status_code           as item_status
from raw_uniware.sale_orders o
join raw_uniware.sale_order_items i on i.sale_order_code = o.code
where 'ecomm' = any (core.fn_user_business_units());

comment on view sales.vw_ecomm_order_lines is
  'Line grain: order x item. Only includes orders whose GetSaleOrder enrichment has run (items_synced_at not null on raw_uniware.sale_orders) — an incomplete subset of sales.vw_ecomm_orders by design, see 0067''s header.';

revoke all on sales.vw_ecomm_order_lines from anon;
grant select on sales.vw_ecomm_order_lines to authenticated;

-- -----------------------------------------------------------------------------
-- Daily rollup — channel x date
-- -----------------------------------------------------------------------------
create or replace view sales.vw_ecomm_daily as
with orders_agg as (
  select
    channel, order_date,
    count(*)                                       as total_orders,
    count(*) filter (where status = 'CANCELLED')   as cancelled_orders,
    count(*) filter (where items_enriched)          as enriched_orders
  from sales.vw_ecomm_orders
  group by channel, order_date
),
lines_agg as (
  select
    channel, order_date,
    count(*)                                                     as units,
    sum(selling_price)                                           as gross_selling_value,
    sum(selling_price) filter (where status <> 'CANCELLED')      as net_selling_value,
    sum(mrp)                                                     as gross_mrp_value,
    sum(discount)                                                as discount_value
  from sales.vw_ecomm_order_lines
  group by channel, order_date
)
select
  o.channel, o.order_date,
  o.total_orders, o.cancelled_orders, o.enriched_orders,
  coalesce(l.units, 0)                as units,
  coalesce(l.net_selling_value, 0)    as net_selling_value,
  coalesce(l.gross_mrp_value, 0)      as gross_mrp_value,
  coalesce(l.discount_value, 0)       as discount_value,
  round(100.0 * coalesce(l.discount_value, 0) / nullif(l.gross_mrp_value, 0), 2) as discount_pct,
  (o.enriched_orders < o.total_orders) as revenue_incomplete
from orders_agg o
left join lines_agg l using (channel, order_date);

comment on view sales.vw_ecomm_daily is
  'One row per channel per calendar day with at least one order (unlike sales.vw_ebo_sales_daily, no zero-order spine — Ecomm has no fixed "store list" to spine against). revenue_incomplete = true means net_selling_value/discount_value are a FLOOR, not final, for that day — some orders are still queued for item enrichment.';

grant select on sales.vw_ecomm_daily to authenticated;

-- -----------------------------------------------------------------------------
-- Monthly rollup — channel x month
-- -----------------------------------------------------------------------------
create or replace view sales.vw_ecomm_monthly as
select
  channel,
  date_trunc('month', order_date)::date as month_start,
  sum(total_orders)                     as total_orders,
  sum(cancelled_orders)                 as cancelled_orders,
  sum(units)                            as units,
  sum(net_selling_value)                as net_selling_value,
  sum(gross_mrp_value)                  as gross_mrp_value,
  sum(discount_value)                   as discount_value,
  round(100.0 * sum(discount_value) / nullif(sum(gross_mrp_value), 0), 2) as discount_pct,
  bool_or(revenue_incomplete)           as revenue_incomplete
from sales.vw_ecomm_daily
group by channel, date_trunc('month', order_date);

comment on view sales.vw_ecomm_monthly is
  'revenue_incomplete = true if ANY day rolled into this month still has unenriched orders — a month is only "final" once every day in it reports false.';

grant select on sales.vw_ecomm_monthly to authenticated;
