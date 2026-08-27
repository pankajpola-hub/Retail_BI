-- =============================================================================
-- 0094 · Data-correctness fixes from the 2026-08-27 four-agent audit
--        (docs/audit/A-filters.md, B-api-security.md, C-database.md, D-frontend.md)
-- =============================================================================
-- Every change below is a `create or replace view` (or function) — additive,
-- no drops, no data writes, no reloptions changed (none of the touched views
-- carry custom reloptions today, confirmed live before writing this). Safe to
-- run standalone; does not depend on 0093 having run first, though 0093
-- should be run too (it fixes DATA, this fixes VIEW DEFINITIONS — different
-- bugs that happened to be discovered in the same audit).
--
-- Scope: only the audit findings with an UNAMBIGUOUS, low-risk fix are here.
-- Explicitly NOT included, and why:
--   * C-09 (vw_sale_transactions_export / vw_stock_with_scheme reachable
--     directly over PostgREST with no store/role scoping) — the correct fix
--     depends on which roles legitimately need whole-network access via
--     which pages (Replenishment/Mix read both views too, and are reachable
--     by more than ho_admin/super_admin), which this migration cannot decide
--     safely. Needs a product decision; tracked separately.
--   * C-06 (cross-source line_seq collision), C-07 (weekly ATV numerator),
--     C-10 (dual store-exclusion mechanism), C-12 (test rows), C-14/C-15/C-16
--     (schema hygiene) — each needs either an application-code change or a
--     judgment call outside a mechanical view fix; tracked separately.

-- -----------------------------------------------------------------------------
-- C-02 — 89% of current-FY sales invisible to the hourly view (bill_time regex)
-- -----------------------------------------------------------------------------
-- sale_detail's own bill_time is single-digit-hour ("3:48:30 PM"); the regex
-- guarding to_timestamp() demanded a zero-padded two-digit hour ("03:48:30
-- PM"), which only the Excel export ever produced. Every sync-written row's
-- bill_time therefore parsed to NULL, and vw_ebo_sales_hourly's
-- `WHERE bill_time IS NOT NULL` silently dropped it. Fix: accept 1-2 digit
-- hours — to_timestamp(..., 'HH12:MI:SS AM') already parses "3:48:30 PM"
-- correctly, the regex was the only thing rejecting it.
create or replace view sales.vw_ebo_sales_lines as
select
  s.store_id,
  parsed.branch_date as bill_date,
  st.bill_no,
  case
    when st.bill_no like '%SB-%' then 'SALE'
    when st.bill_no like '%RB-%' then 'RETURN'
    else 'OTHER'
  end as bill_type,
  st.item_code,
  st.total_quantity,
  st.gross_amount,
  coalesce(st.net_amount, st.gross_amount) as net_amount,
  st.gross_amount - coalesce(st.net_amount, st.gross_amount) as discount_amount,
  nullif(trim(st.scheme_name), '') as scheme_name,
  nullif(trim(st.scheme_group_name), '') as scheme_group_name,
  nullif(trim(st.agent_name), '') as agent_name,
  parsed.bill_time_parsed as bill_time,
  st.id as line_id,
  coalesce(nullif(trim(im.category), ''), nullif(trim(st.category), '')) as category
from raw_logic.sales_transactions st
  cross join lateral (
    select
      case
        when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$'
          then to_date(st.bill_date, 'DD/MM/YYYY')
        else st.bill_date::date
      end as branch_date,
      -- C-02 fix: {2} -> {1,2} on the hour group only. Minute/second stay
      -- two digits (that's how both sources emit them; no case seen otherwise).
      case
        when st.bill_time ~ '^\d{1,2}:\d{2}:\d{2} (AM|PM)$'
          then to_timestamp(st.bill_time, 'HH12:MI:SS AM')::time
        else null::time
      end as bill_time_parsed
  ) parsed
  join core.stores s on s.branch_name_erp = st.branch_name and s.is_active
  left join raw_logic.item_master im on im.item_code = st.item_code
where st.branch_name is not null
  and st.bill_no not in ('BRANCH WISE TOTALS', 'GRAND TOTALS')
  and s.store_id = any (core.fn_user_store_ids());

comment on view sales.vw_ebo_sales_lines is
  'Store-scoped sale line grain. bill_time_parsed accepts 1-2 digit hours (0094/C-02) — sale_detail_sync writes single-digit hours ("3:48:30 PM") which the original {2}-digit regex silently dropped, hiding 89% of current-FY rows from vw_ebo_sales_hourly.';

-- -----------------------------------------------------------------------------
-- C-04 — Ecomm discount understated: channel-reported `discount` is often 0
-- -----------------------------------------------------------------------------
-- Uniware's own `discount` column is 0 for AJIO (250/250 rows), most SHOPIFY
-- and nearly all TATACLIQ orders even when the item clearly sold below MRP.
-- Fix: derive the realised discount as mrp - selling_price whenever the
-- reported discount is 0/null, floored at 0 (one row has discount > mrp,
-- which would otherwise go negative). Verified live: 37.67% (sync) vs 37.45%
-- (Excel) discount already agree on the SALE side of raw_logic — this fix is
-- purely about the Ecomm/Uniware side reading a column that isn't populated.
create or replace view sales.vw_ecomm_order_lines as
select
  o.code as order_code,
  o.display_order_code,
  o.channel,
  o.status,
  o.order_datetime,
  o.order_datetime::date as order_date,
  i.item_sku,
  i.item_name as style,
  i.size,
  i.color,
  i.brand,
  i.selling_price,
  i.total_price,
  i.mrp,
  -- C-04 fix: prefer the channel-reported discount when it's non-zero and
  -- plausible; otherwise derive from mrp - selling_price. greatest(...,0)
  -- guards the one known row where discount (1144) exceeds mrp (1199).
  greatest(coalesce(nullif(i.discount, 0), i.mrp - i.selling_price), 0) as discount,
  i.facility_code,
  i.status_code as item_status
from raw_uniware.sale_orders o
  join raw_uniware.sale_order_items i on i.sale_order_code = o.code
where 'ecomm'::core.business_unit = any (core.fn_user_business_units());

comment on view sales.vw_ecomm_order_lines is
  'Ecomm order-line grain. discount is derived as mrp - selling_price when the channel''s own discount field is 0/absent (0094/C-04) — AJIO/Shopify/TataCliq mostly do not populate it, which understated realised discount by ~16 points network-wide (27.47% reported vs 43.67% true, verified 2026-08-27).';

-- -----------------------------------------------------------------------------
-- C-08 — vw_ecomm_daily mixes cancelled and non-cancelled orders across columns
-- -----------------------------------------------------------------------------
-- Only net_selling_value excluded CANCELLED orders; units, gross_mrp_value
-- and discount_value did not, so discount_pct divided a cancelled-inclusive
-- numerator by a cancelled-inclusive denominator while sitting next to a
-- cancelled-exclusive net figure. Fix: exclude CANCELLED consistently across
-- all four measures (matches net_selling_value's existing filter).
create or replace view sales.vw_ecomm_daily as
with orders_agg as (
  select
    o.channel,
    o.order_date,
    count(*) as total_orders,
    count(*) filter (where o.status = 'CANCELLED') as cancelled_orders,
    count(*) filter (where o.items_enriched) as enriched_orders
  from sales.vw_ecomm_orders o
  group by o.channel, o.order_date
), lines_agg as (
  select
    l.channel,
    l.order_date,
    -- C-08 fix: all four measures now share the same CANCELLED exclusion
    -- net_selling_value already had (previously units/gross_mrp_value/
    -- discount_value counted cancelled lines, overstating by 86 units,
    -- Rs 1,89,110 MRP and Rs 58,174 discount network-wide, verified 2026-08-27).
    count(*) filter (where l.status <> 'CANCELLED') as units,
    sum(l.selling_price) as gross_selling_value,
    sum(l.selling_price) filter (where l.status <> 'CANCELLED') as net_selling_value,
    sum(l.mrp) filter (where l.status <> 'CANCELLED') as gross_mrp_value,
    sum(l.discount) filter (where l.status <> 'CANCELLED') as discount_value
  from sales.vw_ecomm_order_lines l
  group by l.channel, l.order_date
)
select
  o.channel,
  o.order_date,
  o.total_orders,
  o.cancelled_orders,
  o.enriched_orders,
  coalesce(l.units, 0) as units,
  coalesce(l.net_selling_value, 0) as net_selling_value,
  coalesce(l.gross_mrp_value, 0) as gross_mrp_value,
  coalesce(l.discount_value, 0) as discount_value,
  round(100.0 * coalesce(l.discount_value, 0) / nullif(l.gross_mrp_value, 0), 2) as discount_pct,
  o.enriched_orders < o.total_orders as revenue_incomplete
from orders_agg o
  left join lines_agg l using (channel, order_date);

comment on view sales.vw_ecomm_daily is
  'Ecomm daily rollup. units/gross_mrp_value/discount_value now exclude CANCELLED orders, matching net_selling_value (0094/C-08) — previously the four measures disagreed on which orders counted, overstating units/MRP/discount and mismatching discount_pct''s own numerator against its denominator.';

-- -----------------------------------------------------------------------------
-- C-11 — fn_user_business_units() has no service_role branch
-- -----------------------------------------------------------------------------
-- core.fn_user_store_ids() resolves to every store for a service_role client;
-- fn_user_business_units() resolves to NULL, so 'ecomm' = ANY(NULL) is NULL
-- and every vw_ecomm_* view silently returns zero rows to a service-role
-- caller. Latent today (no admin/service-role path reads Ecomm yet — checked:
-- lib/exports/scheduledExports.ts and lib/alerts/runDueAlerts.ts touch only
-- vw_ebo_*/vw_footfall_*/ops.*), but the next scheduled export or alert that
-- adds Ecomm coverage would hit a silent-zero trap without this.
create or replace function core.fn_user_business_units()
returns core.business_unit[]
language sql
stable security definer
set search_path to 'core', 'pg_temp'
as $function$
  select case
    when coalesce(current_setting('request.jwt.claims', true)::json ->> 'role', '') = 'service_role'
      then (select array_agg(distinct business_unit) from core.user_business_units)
    else
      (select array_agg(business_unit) from core.user_business_units where user_id = core.current_user_id())
  end;
$function$;

comment on function core.fn_user_business_units() is
  'Business units the current caller may see. service_role resolves to every business unit ever granted to anyone (0094/C-11), mirroring fn_user_store_ids()''s existing service_role branch — previously resolved to NULL for service_role, so every vw_ecomm_* view silently returned zero rows to an admin/service client.';

-- -----------------------------------------------------------------------------
-- C-13 — vw_sale_transactions_export.discount_amount can be NULL
-- -----------------------------------------------------------------------------
-- gross_amount - net_amount with no COALESCE, unlike the sibling
-- vw_ebo_sales_lines which already does gross - COALESCE(net, gross). 11 rows
-- have net_amount IS NULL, so those export rows carry a NULL discount that a
-- naive JS consumer reads as 0 rather than a flagged gap. Fix: match the
-- sibling view's COALESCE.
create or replace view sales.vw_sale_transactions_export as
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
  -- C-13 fix: COALESCE(net_amount, gross_amount) matches vw_ebo_sales_lines'
  -- own discount_amount formula, so a NULL net_amount row now shows the same
  -- (zero) discount there as it does everywhere else, instead of NULL.
  st.gross_amount - coalesce(st.net_amount, st.gross_amount) as discount_amount,
  st.agent_name,
  nullif(trim(st.scheme_name), '') as scheme_name,
  nullif(trim(st.scheme_group_name), '') as scheme_group_name,
  st.bill_time,
  st.line_seq,
  case
    when extract(month from (case when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$' then to_date(st.bill_date, 'DD/MM/YYYY') else st.bill_date::date end)) >= 4
      then 'FY' || extract(year from (case when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$' then to_date(st.bill_date, 'DD/MM/YYYY') else st.bill_date::date end))::int || '-' ||
           lpad(((extract(year from (case when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$' then to_date(st.bill_date, 'DD/MM/YYYY') else st.bill_date::date end))::int + 1) % 100)::text, 2, '0')
    else 'FY' || (extract(year from (case when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$' then to_date(st.bill_date, 'DD/MM/YYYY') else st.bill_date::date end))::int - 1) || '-' ||
         lpad((extract(year from (case when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$' then to_date(st.bill_date, 'DD/MM/YYYY') else st.bill_date::date end))::int % 100)::text, 2, '0')
  end as financial_year,
  im.item_name,
  im.shade_name,
  im.season,
  im.market_segment,
  im.gender,
  im.size_group,
  im.mrp,
  im.size
from raw_logic.sales_transactions st
  left join core.stores s on s.branch_name_erp = st.branch_name
  left join raw_logic.item_master im on im.item_code = st.item_code
where st.branch_name is not null
  and st.bill_no not in ('BRANCH WISE TOTALS', 'GRAND TOTALS');

comment on view sales.vw_sale_transactions_export is
  'Unscoped (admin-only, gated at the route layer) full export of raw_logic.sales_transactions. discount_amount now COALESCEs net_amount to gross_amount (0094/C-13), matching vw_ebo_sales_lines, so a NULL net_amount row shows 0 discount instead of NULL. SECURITY NOTE (C-09, not fixed here): this view has no store/role predicate of its own and is reachable directly over PostgREST by any authenticated JWT, not just through the route''s own role check. Not hardened in 0094 because Replenishment/Mix also read this view for roles broader than ho_admin/super_admin — the correct scope needs a product decision on which roles should see whole-network line-level data, tracked separately.';

notify pgrst, 'reload schema';
