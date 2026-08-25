-- =============================================================================
-- 0087 · Add a real `size` (exact) column to raw_logic.item_master
-- =============================================================================
-- Root cause of "Size shows blank/Unclassified for most items" in Sale vs
-- Stock Mix's attribute-wise views: raw_logic.item_master (0054) never had
-- an exact-size column at all — only size_group. Worse, the master-upload
-- parser's alias list for sizeGroup was ["sizegroup", "size"] (see
-- web/lib/erpReports/parseMasterWorkbook.ts), so a column literally named
-- "Size" in a customer's master file was ALSO mapped into size_group,
-- silently discarding the exact size even when the uploaded file had it.
-- Confirmed live: item_master genuinely has no way to answer "what's the
-- exact size of barcode X" for an item this app only ever sees through a
-- SALE row (see 0085's header for why stock-only items don't cover this).
--
-- Fix, three parts:
--  1. (this migration) add raw_logic.item_master.size, and thread it
--     through ops.fn_process_master_upload's jsonb_to_recordset shape and
--     upsert column list. Existing rows get size = NULL until the next
--     master re-upload backfills it (the app code deploying alongside this
--     migration fixes the alias collision so a re-upload actually captures
--     it — see parseMasterWorkbook.ts's next commit).
--  2. sales.vw_stock_with_scheme: size now coalesces im.size over ss.size
--     (same "master fills a gap the source report leaves" pattern 0056
--     already applies to season/gender/size_group), instead of reading
--     ss.size directly with no item_master involvement at all.
--  3. sales.vw_sale_transactions_export: adds im.size at the end (new
--     column, same "append only" constraint as 0085/0086), so a sale-only
--     item_code — one with no row in the stock snapshot — can finally
--     carry a real exact size instead of "Unclassified".

alter table raw_logic.item_master add column if not exists size text;

comment on column raw_logic.item_master.size is
  'Exact size (0087) — distinct from size_group. Was previously not captured at all: the master-upload parser mapped a literal "Size" column header into size_group (see parseMasterWorkbook.ts FIELD_ALIASES before this fix), so no master upload, however complete, could have populated an exact size. Existing rows are NULL until the next master re-upload.';

create or replace function ops.fn_process_master_upload(
  p_upload_id uuid,
  p_rows jsonb,
  p_source_file text
)
returns jsonb
language plpgsql
security definer
set search_path = core, raw_logic, ops, extensions, pg_temp
as $$
declare
  v_inserted integer;
  v_updated  integer;
begin
  if core.fn_user_role() not in ('ho_admin', 'super_admin') then
    raise exception 'Only HO Admin / Super Admin can process ERP report uploads.';
  end if;

  with parsed as (
    select *
    from jsonb_to_recordset(p_rows) as x(
      item_code text, item_name text, shade_name text, pack_size text,
      category text, subcategory text, season text, market_segment text,
      gender text, size_group text, size text, mrp numeric
    )
  ),
  upserted as (
    insert into raw_logic.item_master
      (item_code, item_name, shade_name, pack_size, category, subcategory,
       season, market_segment, gender, size_group, size, mrp, source_file, updated_at)
    select item_code, item_name, shade_name, pack_size, category, subcategory,
           season, market_segment, gender, size_group, size, mrp, p_source_file, now()
    from parsed
    on conflict (item_code) do update set
      item_name      = coalesce(excluded.item_name,      raw_logic.item_master.item_name),
      shade_name     = coalesce(excluded.shade_name,     raw_logic.item_master.shade_name),
      pack_size      = coalesce(excluded.pack_size,      raw_logic.item_master.pack_size),
      category       = coalesce(excluded.category,       raw_logic.item_master.category),
      subcategory    = coalesce(excluded.subcategory,    raw_logic.item_master.subcategory),
      season         = coalesce(excluded.season,         raw_logic.item_master.season),
      market_segment = coalesce(excluded.market_segment, raw_logic.item_master.market_segment),
      gender         = coalesce(excluded.gender,         raw_logic.item_master.gender),
      size_group     = coalesce(excluded.size_group,     raw_logic.item_master.size_group),
      size           = coalesce(excluded.size,            raw_logic.item_master.size),
      mrp            = coalesce(excluded.mrp,            raw_logic.item_master.mrp),
      source_file    = excluded.source_file,
      updated_at     = now()
    returning (xmax = 0) as was_insert
  )
  select
    count(*) filter (where was_insert),
    count(*) filter (where not was_insert)
  into v_inserted, v_updated
  from upserted;

  update ops.erp_report_uploads set status = 'processed', notes = null where id = p_upload_id;

  return jsonb_build_object(
    'inserted', coalesce(v_inserted, 0),
    'updated',  coalesce(v_updated, 0),
    'total',    coalesce(v_inserted, 0) + coalesce(v_updated, 0)
  );
end;
$$;

revoke all on function ops.fn_process_master_upload(uuid, jsonb, text) from public, anon;
grant execute on function ops.fn_process_master_upload(uuid, jsonb, text) to authenticated;

-- sales.vw_stock_with_scheme — size now fills from item_master when the
-- stock snapshot's own size is blank, same coalesce pattern 0056 already
-- uses for season/gender/size_group.
create or replace view sales.vw_stock_with_scheme
with (security_invoker = off, security_barrier = true) as
select
  ss.id, ss.branch_name, ss.godown_name, ss.company_name,
  coalesce(nullif(trim(im.season), ''), ss.season)                       as season,
  coalesce(nullif(trim(im.market_segment), ''), ss.market_segment)       as market_segment,
  coalesce(nullif(trim(im.gender), ''), nullif(trim(ss.gender), ''))     as gender,
  coalesce(nullif(trim(im.size_group), ''), nullif(trim(ss.size_group), '')) as size_group,
  coalesce(nullif(trim(im.subcategory), ''), ss.subcategory)             as subcategory,
  ss.item_code,
  coalesce(nullif(trim(im.item_name), ''), ss.item_name)                 as item_name,
  coalesce(nullif(trim(im.shade_name), ''), ss.shade_name)               as shade_name,
  coalesce(nullif(trim(im.size), ''), nullif(trim(ss.size), ''))         as size,
  ss.closing_stock, ss.rate,
  sl.scheme_name,
  sl.discount_pct,
  coalesce(sl.is_discounted_50plus, false) as is_eoss,
  im.mrp
from raw_logic.stock_snapshot ss
left join raw_logic.item_master im on im.item_code = ss.item_code
left join raw_logic.scheme_lookup sl on sl.item_code = ss.item_code;

comment on view sales.vw_stock_with_scheme is
  'Stock snapshot rows enriched with scheme/EOSS info (0024), product-attribute fields (0056: item_name, shade_name, season, market_segment, gender, size_group, subcategory), mrp (0084), and size (0087, coalesced from item_master over the stock snapshot''s own size, same pattern as every other attribute here). rate (from stock_snapshot) and mrp (from item_master) are separate fields from separate source tables and are not guaranteed to match.';

grant select on sales.vw_stock_with_scheme to authenticated;

-- sales.vw_sale_transactions_export — adds im.size at the end (new column,
-- same append-only constraint as 0085/0086: Postgres forbids reordering an
-- existing view's output columns under CREATE OR REPLACE VIEW).
create or replace view sales.vw_sale_transactions_export
with (security_invoker = off, security_barrier = true) as
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
  (st.gross_amount - st.net_amount) as discount_amount,
  st.agent_name,
  nullif(trim(st.scheme_name), '') as scheme_name,
  nullif(trim(st.scheme_group_name), '') as scheme_group_name,
  st.bill_time,
  st.line_seq,
  case
    when extract(month from (case
      when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$' then to_date(st.bill_date, 'DD/MM/YYYY')
      else st.bill_date::date
    end)) >= 4
    then 'FY' || extract(year from (case
      when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$' then to_date(st.bill_date, 'DD/MM/YYYY')
      else st.bill_date::date
    end))::int
      || '-' || lpad(((extract(year from (case
        when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$' then to_date(st.bill_date, 'DD/MM/YYYY')
        else st.bill_date::date
      end))::int + 1) % 100)::text, 2, '0')
    else 'FY' || (extract(year from (case
      when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$' then to_date(st.bill_date, 'DD/MM/YYYY')
      else st.bill_date::date
    end))::int - 1)
      || '-' || lpad((extract(year from (case
        when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$' then to_date(st.bill_date, 'DD/MM/YYYY')
        else st.bill_date::date
      end))::int % 100)::text, 2, '0')
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
  'Unfiltered (no store-scoping, no active-only join) read of the full merged raw_logic.sales_transactions history, for the HO-wide "Download merged sale file" export AND (0085) for Sale vs Stock Mix''s attribute-wise views. bill_type (0086) matches SB-/RB- as a SUBSTRING anywhere in bill_no. financial_year (0033) is computed inline (Apr-Mar, e.g. FY2026-27). size (0087) is item_master''s exact size, independent of size_group — a sale-only item_code (no row in the current stock snapshot) can now carry a real size instead of "Unclassified", PROVIDED item_master itself has it (existing rows are NULL until the next master re-upload with the parser fix that stops folding a literal "Size" header into size_group). security_invoker = OFF, same reasoning as sales.vw_stock_with_scheme (0024) — access control is entirely at the route layer (ho_admin/super_admin), not in this view. Never expose this view to non-admin roles without adding a row filter first.';

grant select on sales.vw_sale_transactions_export to authenticated;

notify pgrst, 'reload schema';
