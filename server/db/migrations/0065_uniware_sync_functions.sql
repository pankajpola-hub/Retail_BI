-- =============================================================================
-- 0065 · ops.fn_upsert_uniware_* — the only door into raw_uniware from the app
-- =============================================================================
-- Same reason raw_logic is never queried directly (0001's header): PostgREST
-- only routes requests for schemas in Supabase's "Exposed schemas" dashboard
-- setting, and raw_uniware deliberately isn't in it (0063's header — "reachable
-- only through the service-role sync job"). Rather than adding raw_uniware to
-- that list (a manual dashboard step, same one already done once for
-- core/sales/ops/marketing/workspace), these SECURITY DEFINER functions live
-- in `ops` (already exposed) and reach into raw_uniware via plain SQL inside
-- the function body — invisible to PostgREST's schema routing, same trick
-- ops.fn_process_sale_upload already uses for raw_logic.
--
-- Callers: web/app/api/cron/uniware-sync/route.ts, using the service-role
-- admin client (lib/data/admin.ts) — never an end user, so unlike
-- ops.fn_process_sale_upload these do NOT grant execute to `authenticated` at
-- all, only to `service_role`. No internal role check either (core.fn_user_role()
-- would even be meaningless here — the caller has no user session, it's a
-- Vercel Cron invocation authenticated by CRON_SECRET at the route level).

create or replace function ops.fn_upsert_uniware_orders(p_rows jsonb)
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
      code text, display_order_code text, channel text, status text,
      order_datetime timestamptz, created_on timestamptz, updated_on timestamptz,
      notification_email text, notification_mobile text
    )
  ),
  ins as (
    insert into raw_uniware.sale_orders
      (code, display_order_code, channel, status, order_datetime, created_on, updated_on,
       notification_email, notification_mobile, _synced_at)
    select code, display_order_code, channel, status, order_datetime, created_on, updated_on,
           notification_email, notification_mobile, now()
    from parsed
    on conflict (code) do update set
      display_order_code  = excluded.display_order_code,
      channel              = excluded.channel,
      status                = excluded.status,
      order_datetime         = excluded.order_datetime,
      created_on              = excluded.created_on,
      updated_on               = excluded.updated_on,
      notification_email        = excluded.notification_email,
      notification_mobile        = excluded.notification_mobile,
      _synced_at                  = now()
    returning 1
  )
  select count(*) into v_count from ins;
  return v_count;
end;
$$;

revoke all on function ops.fn_upsert_uniware_orders(jsonb) from public, anon, authenticated;
grant execute on function ops.fn_upsert_uniware_orders(jsonb) to service_role;

create or replace function ops.fn_upsert_uniware_order_items(p_sale_order_code text, p_rows jsonb)
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
      item_code text, item_sku text, item_name text, size text, color text, brand text,
      status_code text, facility_code text, selling_price numeric, total_price numeric,
      shipping_charges numeric, gift_wrap numeric, mrp numeric, discount numeric, hsn_code text,
      created_on timestamptz, updated_on timestamptz
    )
  ),
  ins as (
    insert into raw_uniware.sale_order_items
      (sale_order_code, item_code, item_sku, item_name, size, color, brand, status_code,
       facility_code, selling_price, total_price, shipping_charges, gift_wrap, mrp, discount,
       hsn_code, created_on, updated_on, _synced_at)
    select p_sale_order_code, item_code, item_sku, item_name, size, color, brand, status_code,
           facility_code, selling_price, total_price, shipping_charges, gift_wrap, mrp, discount,
           hsn_code, created_on, updated_on, now()
    from parsed
    on conflict (sale_order_code, item_code) do update set
      item_sku          = excluded.item_sku,
      item_name          = excluded.item_name,
      size                = excluded.size,
      color                = excluded.color,
      brand                 = excluded.brand,
      status_code            = excluded.status_code,
      facility_code            = excluded.facility_code,
      selling_price              = excluded.selling_price,
      total_price                  = excluded.total_price,
      shipping_charges               = excluded.shipping_charges,
      gift_wrap                        = excluded.gift_wrap,
      mrp                                = excluded.mrp,
      discount                             = excluded.discount,
      hsn_code                               = excluded.hsn_code,
      created_on                               = excluded.created_on,
      updated_on                                 = excluded.updated_on,
      _synced_at                                   = now()
    returning 1
  )
  select count(*) into v_count from ins;

  update raw_uniware.sale_orders set items_synced_at = now() where code = p_sale_order_code;

  return v_count;
end;
$$;

revoke all on function ops.fn_upsert_uniware_order_items(text, jsonb) from public, anon, authenticated;
grant execute on function ops.fn_upsert_uniware_order_items(text, jsonb) to service_role;

-- Read side of the items_synced_at queue (0063's header) — the sync job asks
-- "which orders still need a GetSaleOrder enrichment call", oldest-priority
-- newest-first so a partial pass always makes progress on the most recent
-- (most reportable) orders first.
create or replace function ops.fn_uniware_orders_needing_items(p_limit integer default 150)
returns table(code text)
language sql
security definer
set search_path = raw_uniware, ops, extensions, pg_temp
as $$
  select code
  from raw_uniware.sale_orders
  where items_synced_at is null
  order by order_datetime desc nulls last
  limit p_limit;
$$;

revoke all on function ops.fn_uniware_orders_needing_items(integer) from public, anon, authenticated;
grant execute on function ops.fn_uniware_orders_needing_items(integer) to service_role;

notify pgrst, 'reload schema';
