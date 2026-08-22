-- =============================================================================
-- 0063 · raw_uniware — Ecomm (Uniware/Unicommerce SOAP API v1.9) ingest schema
-- =============================================================================
-- Same posture as raw_logic (0001's header): a landing schema for one
-- external system, zero grants to anon/authenticated, reachable only via the
-- service-role sync job for now (a sales.vw_ecomm_* view layer, matching
-- sales.vw_ebo_sales_lines for Retail, is later work once real data has
-- landed and been eyeballed — not guessed ahead of time the way 0004's
-- original raw_logic stub was and had to be corrected).
--
-- VERIFIED against the live tenant (peppermint.unicommerce.com, 2026-08-22),
-- not guessed from public docs: auth is WS-Security UsernameToken (a
-- per-operation Username+APIKey pair from Uniware's own Settings -> API
-- screen), SearchSaleOrder returns order-level facts, GetSaleOrder adds
-- per-item line detail. Field names below are taken from the tenant's own
-- WSDL (SaleOrderDTO / SaleOrderItemDetailDTO complex types) cross-checked
-- against D:\Py\VMS_Peppermint's already-working integration for this same
-- Uniware tenant.
--
-- Two tables, two sync cadences, deliberately decoupled:
--   sale_orders      — header facts (channel, status, dates). Cheap: one
--                       SearchSaleOrder call fetches ~100 orders per page,
--                       no per-order round trip.
--   sale_order_items — SKU/style/size/price line detail. Expensive: needs
--                       one GetSaleOrder call PER ORDER. items_synced_at
--                       (null until enriched) is the queue a separate,
--                       rate-limited enrichment pass drains — doing this in
--                       the same pass as the header sync would mean one
--                       Vercel function invocation making thousands of
--                       sequential SOAP calls, risking the function's
--                       duration limit on any real backfill.
--
-- Sync strategy is a ROLLING WINDOW re-sync (re-pull the last N days every
-- run), not an update-since cursor — SearchSaleOrder's own filter fields
-- (verified against the WSDL) are FromDate/ToDate on the order's placement
-- date, with no "updated since" filter the way SearchShippingPackage has
-- (UpdatedSinceInMinutes). Re-pulling the same window repeatedly is safe
-- because both tables upsert on their natural key — this only misses a
-- status change (e.g. a late return) on an order OLDER than the rolling
-- window, an accepted tradeoff for a BI reporting tool, not an ops system.

create schema if not exists raw_uniware;
comment on schema raw_uniware is 'Uniware/Unicommerce SOAP API v1.9 sync destination (Ecomm). App roles have no direct grants here — same posture as raw_logic.';
revoke all on schema raw_uniware from anon, authenticated;

-- -----------------------------------------------------------------------------
-- Order headers — SearchSaleOrder
-- -----------------------------------------------------------------------------
create table raw_uniware.sale_orders (
  code                 text primary key,        -- Uniware's internal order Code (a UUID, confirmed live — NOT the marketplace order number)
  display_order_code   text,                     -- customer/marketplace-facing order number
  channel              text,                     -- e.g. 'MYNTRA', 'AJIO' — free text, Uniware does not enumerate this
  status                text,                    -- e.g. 'PROCESSING', 'CANCELLED', 'COMPLETE'
  order_datetime        timestamptz,             -- SearchSaleOrder's DisplayOrderDateTime — what FromDate/ToDate filters on
  created_on            timestamptz,
  updated_on            timestamptz,
  notification_email    text,
  notification_mobile   text,
  items_synced_at       timestamptz,             -- null = queued for GetSaleOrder enrichment; see header note
  _synced_at             timestamptz not null default now()
);

comment on table raw_uniware.sale_orders is
  'One row per Uniware sale order, header-level only. Upserted by the rolling-window header sync; items_synced_at drives the separate line-item enrichment pass (see 0063 header).';
comment on column raw_uniware.sale_orders.items_synced_at is
  'Null until a GetSaleOrder enrichment call has populated raw_uniware.sale_order_items for this order. Left null (not re-checked) once set — an order''s line items do not change after creation, only its status/header fields do, which the header sync keeps current on every rolling-window pass.';

create index sale_orders_order_datetime_idx on raw_uniware.sale_orders (order_datetime desc);
create index sale_orders_needs_items_idx on raw_uniware.sale_orders (order_datetime) where items_synced_at is null;

-- -----------------------------------------------------------------------------
-- Line items — GetSaleOrder enrichment
-- -----------------------------------------------------------------------------
create table raw_uniware.sale_order_items (
  id                bigint generated always as identity primary key,
  sale_order_code   text not null references raw_uniware.sale_orders (code) on delete cascade,
  item_code         text,       -- SaleOrderItemDetailDTO.Code — the per-item code, unique within an order
  item_sku          text,
  item_name         text,       -- confirmed against a real Sale Orders export (VMS_Peppermint's uniware.py): this is Peppermint's style code, not a free-text product name
  size              text,
  color             text,
  status_code       text,
  facility_code     text,
  selling_price     numeric,
  total_price       numeric,
  shipping_charges  numeric,
  gift_wrap         numeric,
  created_on        timestamptz,
  updated_on        timestamptz,
  _synced_at        timestamptz not null default now(),
  unique (sale_order_code, item_code)
);

comment on table raw_uniware.sale_order_items is
  'One row per sale order line item, from GetSaleOrder. Grain: order x item_code. UPSERT on (sale_order_code, item_code) — re-running enrichment for an already-enriched order is a no-op cost, not a duplicate risk.';

create index sale_order_items_sale_order_code_idx on raw_uniware.sale_order_items (sale_order_code);

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
-- Learned the hard way on 0061/0062: Supabase's service_role has BYPASSRLS,
-- but that only waives RLS POLICIES, not ordinary table-level GRANT
-- privileges — an insert attempt against an ungranted table fails with
-- "permission denied" regardless of BYPASSRLS. Granting explicitly here from
-- the start rather than discovering the same gap again on first sync.
grant usage on schema raw_uniware to service_role;
grant select, insert, update, delete on raw_uniware.sale_orders      to service_role;
grant select, insert, update, delete on raw_uniware.sale_order_items to service_role;

-- No RLS enabled here, matching raw_logic's ingest tables exactly (confirmed
-- live: relrowsecurity = false, zero grants to anyone but the owner) — this
-- schema is reachable only through the service-role sync job today, and
-- later through SECURITY DEFINER views/functions once a sales.vw_ecomm_*
-- layer exists, never through direct authenticated/anon access.

notify pgrst, 'reload schema';
