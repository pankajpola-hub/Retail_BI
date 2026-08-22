-- =============================================================================
-- 0069 · raw_uniware.returns — Uniware REST v1 Returns ingest
-- =============================================================================
-- Companion to 0063's raw_uniware.sale_orders/sale_order_items, but sourced
-- from a COMPLETELY DIFFERENT Uniware API surface: the SOAP v1.9 API (0063's
-- header) has no way to search returns at all — SearchShippingPackage only
-- indexes forward shipments, and GetSaleOrder's <Returns> block needs a sale
-- order code you already have. Confirmed by D:\Py\VMS_Peppermint's
-- backend/app/services/uniware.py (same tenant, same company): a return AWB
-- is simply not findable anywhere in SOAP by itself.
--
-- Uniware's REST v1 API (OAuth2 `password` grant, entirely separate
-- credentials from the SOAP WS-Security pair — see web/lib/uniware/client.ts's
-- restToken()) exposes `Search Return` (list of return codes created in a
-- date window) and `Get Return` (per-code detail: sale order + tracking
-- number). VMS's sync_return_tracking_numbers is the proven reference for
-- both calls' request/response shapes and their gotchas:
--   - Search Return has NO pagination and rejects a FromDate..ToDate window
--     wider than ~30-45 days with INVALID_TIME_INTERVAL — must be walked in
--     <=30-day chunks (see web/app/api/cron/uniware-sync/route.ts's phase 3).
--   - Search Return's date params are "yyyy-MM-dd" only (date, not datetime)
--     — the more common "yyyy-MM-dd HH:mm:ss" form is rejected.
--   - Search Return's response gives ONLY a bare return `code` per row — no
--     status, no tracking number, no sale order. Get Return is required per
--     code for anything else, same one-call-per-item cost shape as 0063's
--     GetSaleOrder item enrichment.
--
-- UNVERIFIED, unlike 0063/0064: this migration is landing without a real
-- Get Return response ever having been inspected (no REST credentials
-- available at authoring time — see this migration's PR description / the
-- sync job's rollout notes). VMS's get_return only ever read
-- returnSaleOrderValue.{trackingNumber,saleOrderCode} — it never needed
-- status or created/updated dates, so those field names below are a
-- best-effort guess at common Unicommerce REST naming (status, createdDate,
-- updatedDate), NOT a confirmed mapping. raw_response captures the entire
-- payload precisely so that guess can be corrected later (a 0064-style
-- follow-up migration) without having lost any data in the meantime — same
-- reasoning as 0064's header, just applied proactively instead of after the
-- fact because real credentials weren't available to verify against first.

create table raw_uniware.returns (
  reverse_pickup_code text primary key,        -- Get Return's key = Search Return's bare `code`
  sale_order_code     text,                    -- best-effort: returnSaleOrderValue.saleOrderCode (confirmed field, per VMS) — no FK constraint, may reference an order older than sale_orders' rolling sync window
  return_awb          text,                    -- returnSaleOrderValue.trackingNumber (confirmed field, per VMS)
  status               text,                    -- UNVERIFIED field name — see header
  created_on            timestamptz,             -- UNVERIFIED field name — see header
  updated_on             timestamptz,             -- UNVERIFIED field name — see header
  raw_response             jsonb,                  -- full Get Return response, so an unverified/wrong column mapping above loses nothing
  _synced_at                 timestamptz not null default now()
);

comment on table raw_uniware.returns is
  'One row per Uniware return (Get Return, keyed by reversePickupCode). Populated by a rolling-window Search Return + per-code Get Return pass (web/app/api/cron/uniware-sync/route.ts phase 3) — same rolling-resync-not-cursor reasoning as raw_uniware.sale_orders (0063), because Search Return has no "updated since" filter either. status/created_on/updated_on are UNVERIFIED field-name guesses (see 0069 header) — raw_response is the source of truth until corrected against a real live payload.';
comment on column raw_uniware.returns.raw_response is
  'Full Get Return JSON response, kept verbatim because status/created_on/updated_on''s field names were guessed without live verification (see 0069 header) — query this directly if the typed columns turn out to be null/wrong for real data.';

create index returns_sale_order_code_idx on raw_uniware.returns (sale_order_code);
create index returns_created_on_idx on raw_uniware.returns (created_on desc);

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
-- schema-level USAGE on raw_uniware was already granted to service_role by
-- 0063 (schemas don't need re-granting per table) — only the new table needs
-- its own explicit table-level grant, same "service_role needs EXPLICIT
-- grants, BYPASSRLS does not substitute" lesson 0063/0065/0066 already paid
-- for.
grant select, insert, update, delete on raw_uniware.returns to service_role;

-- No RLS, zero grants to anon/authenticated — same posture as
-- raw_uniware.sale_orders/sale_order_items (0063's header). Reachable only
-- via the service-role sync job and, once landed, sales.vw_ecomm_returns
-- (0070) as the SECURITY DEFINER-view door in.

-- -----------------------------------------------------------------------------
-- ops.fn_upsert_uniware_returns — the only door into raw_uniware.returns
-- -----------------------------------------------------------------------------
-- Same trick as 0065's ops.fn_upsert_uniware_orders/order_items: PostgREST
-- only routes schemas in Supabase's "Exposed schemas" list, raw_uniware
-- deliberately isn't in it, so this SECURITY DEFINER function lives in the
-- already-exposed `ops` schema and reaches into raw_uniware via plain SQL in
-- its body. Caller is exclusively web/app/api/cron/uniware-sync/route.ts's
-- service-role admin client (no user session involved, same as 0065) — EXECUTE
-- is granted to service_role only, never to authenticated.
create or replace function ops.fn_upsert_uniware_returns(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = raw_uniware, ops, extensions, pg_temp
as $$
declare
  v_count integer;
begin
  with parsed as (
    select *
    from jsonb_to_recordset(p_rows) as x(
      reverse_pickup_code text, sale_order_code text, return_awb text, status text,
      created_on timestamptz, updated_on timestamptz, raw_response jsonb
    )
  ),
  ins as (
    insert into raw_uniware.returns
      (reverse_pickup_code, sale_order_code, return_awb, status, created_on, updated_on, raw_response, _synced_at)
    select reverse_pickup_code, sale_order_code, return_awb, status, created_on, updated_on, raw_response, now()
    from parsed
    on conflict (reverse_pickup_code) do update set
      sale_order_code = excluded.sale_order_code,
      return_awb       = excluded.return_awb,
      status             = excluded.status,
      created_on           = excluded.created_on,
      updated_on             = excluded.updated_on,
      raw_response             = excluded.raw_response,
      _synced_at                 = now()
    returning 1
  )
  select count(*) into v_count from ins;
  return v_count;
end;
$$;

revoke all on function ops.fn_upsert_uniware_returns(jsonb) from public, anon, authenticated;
grant execute on function ops.fn_upsert_uniware_returns(jsonb) to service_role;

notify pgrst, 'reload schema';
