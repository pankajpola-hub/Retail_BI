-- =============================================================================
-- 0070 · sales.vw_ecomm_returns — semantic layer over raw_uniware.returns
-- =============================================================================
-- Same role 0067's sales.vw_ecomm_orders/order_lines play for sale orders:
-- raw_uniware has zero grants to authenticated (0063/0069's header), so this
-- view is the only door in. Landed as its own migration rather than folding
-- into 0067 — this codebase's migrations are an honest historical record and
-- are never edited after landing (0067 shipped before Returns existed).
--
-- Scoping: same business_unit gate as every other sales.vw_ecomm_* view
-- (0061's core.fn_user_business_units()) — a caller either has 'ecomm'
-- granted or every row here is invisible to them, no partial/row-level
-- narrowing.
--
-- Left-joins sale_orders for channel/display-code context (a return's
-- sale_order_code is stored without an FK constraint — see 0069's header —
-- because it may point at an order older than sale_orders' rolling sync
-- window, so the join is deliberately outer, not inner: a return should
-- still be visible even when its originating order has aged out or hasn't
-- synced yet).
create or replace view sales.vw_ecomm_returns as
select
  r.reverse_pickup_code,
  r.sale_order_code,
  o.display_order_code,
  o.channel,
  r.return_awb,
  r.status,
  r.created_on,
  r.created_on::date as return_date,
  r.updated_on
from raw_uniware.returns r
left join raw_uniware.sale_orders o on o.code = r.sale_order_code
where 'ecomm' = any (core.fn_user_business_units());

comment on view sales.vw_ecomm_returns is
  'One row per Uniware return. channel/display_order_code come from a LEFT JOIN to sales orders (nullable — a return''s originating order may be outside sale_orders'' rolling sync window or not yet synced, see 0069/0070 headers). status/created_on/updated_on carry 0069''s UNVERIFIED-field-name caveat — treat as best-effort until corrected against real live data.';

revoke all on sales.vw_ecomm_returns from anon;
grant select on sales.vw_ecomm_returns to authenticated;

notify pgrst, 'reload schema';
