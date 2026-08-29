-- =============================================================================
-- 0099 · Live recon: rebuild ops.recon_lines from raw_uniware
-- =============================================================================
-- The existing uniware-sync cron already lands sale orders + items in
-- raw_uniware.* (0063-0065). Rather than call Uniware again, recon derives
-- itself from that synced data in one SQL pass. Run this migration after 0098.
--
-- Limitation (honest): raw_uniware.sale_order_items carries mrp, selling_price,
-- total_price, discount, hsn_code, status_code — but NOT the GST breakdown or
-- packet id (the SOAP SearchSaleOrder/GetSaleOrder feed does not expose them).
-- So the live refresh computes the arithmetic exceptions (price mismatch,
-- selling>MRP) and completeness (hsn), but not the tax-based ones. Those need
-- the REST saleorder/get feed (totalCentralGst etc.) — a later enhancement.
-- Until then, CANCELLED_WITH_TAX etc. only appear in the CSV-seeded snapshot.
-- =============================================================================

create or replace function ops.refresh_recon_from_uniware()
returns integer
language plpgsql
security definer
set search_path = ops, raw_uniware, public
as $$
declare
  n integer;
begin
  delete from ops.recon_lines;

  insert into ops.recon_lines (
    channel, order_code, item_code, sku, status, order_date,
    mrp, selling_price, total_price, discount,
    cgst, sgst, igst,
    packet_id_present, hsn_present, invoice_present,
    exception_code, exception_severity, exception_amount
  )
  select
    coalesce(o.channel, 'UNKNOWN')                    as channel,
    o.display_order_code                              as order_code,
    i.item_code,
    i.item_sku                                        as sku,
    i.status_code                                     as status,
    (o.order_datetime)::date                          as order_date,
    i.mrp, i.selling_price, i.total_price, i.discount,
    null::numeric, null::numeric, null::numeric,      -- no GST in this feed
    false,                                            -- packet id not exposed here
    (i.hsn_code is not null and i.hsn_code <> '')     as hsn_present,
    false,                                            -- invoice not in this feed
    case
      when i.selling_price is not null and i.total_price is not null
           and abs(i.selling_price - i.total_price) > 1 then 'PRICE_TOTAL_MISMATCH'
      when i.mrp is not null and i.selling_price is not null
           and i.selling_price > i.mrp + 1 then 'SELLING_ABOVE_MRP'
      else 'CLEAN'
    end                                               as exception_code,
    case
      when i.selling_price is not null and i.total_price is not null
           and abs(i.selling_price - i.total_price) > 1 then 'High'
      when i.mrp is not null and i.selling_price is not null
           and i.selling_price > i.mrp + 1 then 'High'
      else 'None'
    end                                               as exception_severity,
    case
      when i.selling_price is not null and i.total_price is not null
           and abs(i.selling_price - i.total_price) > 1 then abs(i.selling_price - i.total_price)
      when i.mrp is not null and i.selling_price is not null
           and i.selling_price > i.mrp + 1 then i.selling_price - i.mrp
      else 0
    end                                               as exception_amount
  from raw_uniware.sale_order_items i
  join raw_uniware.sale_orders o on o.code = i.sale_order_code;

  get diagnostics n = row_count;
  return n;
end;
$$;

grant execute on function ops.refresh_recon_from_uniware() to authenticated, service_role;

-- Make the new function visible to PostgREST immediately.
notify pgrst, 'reload schema';
