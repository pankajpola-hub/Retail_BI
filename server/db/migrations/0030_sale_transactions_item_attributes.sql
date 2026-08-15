-- =============================================================================
-- 0030 · raw_logic.sales_transactions — item-attribute columns from the real
--        FY24-25/25-26/26-27 Sale report exports
-- =============================================================================
-- The user's "STOCK REPORT - MARKETING - {24-25,25-26,26-27}.xlsx" files on
-- their Desktop are mislabeled — sheet "Report", title row reads "MARKETING
-- CAMPAIGN PERFORMANCE REPORT From <start> to <end>" and the columns are the
-- same Sale-report shape 0024 already parses, PLUS nine columns that shape
-- didn't have: SHADE NAME, PACK / SIZE, CATEGORY, SUBCATEGORY, SEASON,
-- MARKET SEGMENT, GENDER, SIZE GROUP, M.R.P. Verified present with real
-- values in the header row of all three files (4750 / 14480 / 4195 raw rows
-- respectively, before excluding title/summary/blank-branch rows — see
-- web/lib/erpReports/parseSaleWorkbook.ts's updated REQUIRED_COLUMNS and
-- test output). Sample real values (file 24-25, row 3): SHADE NAME "BLUE",
-- PACK / SIZE "16", CATEGORY "APPAREL", SUBCATEGORY "DRESS", SEASON
-- "SS2024", MARKET SEGMENT "ORGANIZED RETAIL", GENDER "FEMALE", SIZE GROUP
-- "TODDLERS", M.R.P. 1599.
--
-- Why capture these on the LINE instead of relying on the existing
-- item_code -> attribute lookups (sales.vw_item_subcategory_lookup /
-- raw_logic.stock_snapshot, both fed by whichever Stock report was most
-- recently uploaded): those are POINT-IN-TIME snapshots that replace
-- wholesale on every new Stock upload (0024's header), so joining an old
-- sale line to today's snapshot silently answers "what is this item's
-- gender/subcategory NOW", not "what was it when this line was actually
-- sold" — usually the same, but not guaranteed for a discontinued or
-- re-classified item. The Sale report apparently already carries the
-- as-of-sale values directly, which is strictly better provenance for
-- historical reporting. This migration only adds the columns and threads
-- them through the existing upload pipeline; it does NOT change any
-- existing view or the Targets page's fresh/discounted logic (owned by a
-- parallel agent, out of scope here) — those keep using the snapshot-based
-- lookups they already use unless/until that agent decides to switch.
--
-- All nine columns are nullable text (M.R.P. numeric) — historical rows
-- already in the table (loaded before this migration, or from a Sale report
-- shape that predates these columns) simply have them NULL, same posture as
-- agent_name/scheme_name already have for older rows per 0016/0018's
-- comments elsewhere in this file's history.

alter table raw_logic.sales_transactions
  add column if not exists shade_name      text,
  add column if not exists pack_size       text,
  add column if not exists category        text,
  add column if not exists subcategory     text,
  add column if not exists season          text,
  add column if not exists market_segment  text,
  add column if not exists gender          text,
  add column if not exists size_group      text,
  add column if not exists mrp             numeric;

comment on column raw_logic.sales_transactions.shade_name is
  'From the Sale report''s SHADE NAME column (added 0030) — as-of-sale value, nullable for rows loaded before this column existed.';
comment on column raw_logic.sales_transactions.pack_size is
  'From the Sale report''s PACK / SIZE column (added 0030) — observed as a size/pack code (e.g. "16"), not a quantity.';
comment on column raw_logic.sales_transactions.category is
  'From the Sale report''s CATEGORY column (added 0030). Only one distinct real value ("APPAREL") seen across the three verified files — kept as a free-text capture, not assumed to enumerate cleanly.';
comment on column raw_logic.sales_transactions.subcategory is
  'From the Sale report''s SUBCATEGORY column (added 0030) — as-of-sale value, independent of raw_logic.stock_snapshot''s point-in-time subcategory.';
comment on column raw_logic.sales_transactions.season is
  'From the Sale report''s SEASON column (added 0030).';
comment on column raw_logic.sales_transactions.market_segment is
  'From the Sale report''s MARKET SEGMENT column (added 0030).';
comment on column raw_logic.sales_transactions.gender is
  'From the Sale report''s GENDER column (added 0030) — as-of-sale value, independent of raw_logic.stock_snapshot''s point-in-time gender.';
comment on column raw_logic.sales_transactions.size_group is
  'From the Sale report''s SIZE GROUP column (added 0030).';
comment on column raw_logic.sales_transactions.mrp is
  'From the Sale report''s M.R.P. column (added 0030) — the printed MRP at time of sale, distinct from gross_amount/net_amount.';

-- -----------------------------------------------------------------------------
-- ops.fn_process_sale_upload — accept and write the nine new columns
-- -----------------------------------------------------------------------------
-- Same role gate and upsert shape as 0024's original definition; only the
-- recordset shape and the insert/update column lists change.
create or replace function ops.fn_process_sale_upload(p_upload_id uuid, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = core, raw_logic, ops, extensions, pg_temp
as $$
declare
  v_count integer;
begin
  if core.fn_user_role() not in ('ho_admin', 'super_admin') then
    raise exception 'Only HO Admin / Super Admin can process ERP report uploads.';
  end if;

  with parsed as (
    select *
    from jsonb_to_recordset(p_rows) as x(
      branch_name text, bill_date text, bill_no text, item_code text,
      total_quantity numeric, gross_amount numeric, net_amount numeric,
      agent_name text, scheme_name text, scheme_group_name text, bill_time text,
      shade_name text, pack_size text, category text, subcategory text,
      season text, market_segment text, gender text, size_group text, mrp numeric,
      line_seq integer
    )
  ),
  ins as (
    insert into raw_logic.sales_transactions
      (branch_name, bill_date, bill_no, item_code, total_quantity, gross_amount, net_amount,
       agent_name, scheme_name, scheme_group_name, bill_time,
       shade_name, pack_size, category, subcategory, season, market_segment, gender, size_group, mrp,
       line_seq)
    select branch_name, bill_date, bill_no, item_code, total_quantity, gross_amount, net_amount,
           agent_name, scheme_name, scheme_group_name, bill_time,
           shade_name, pack_size, category, subcategory, season, market_segment, gender, size_group, mrp,
           line_seq
    from parsed
    on conflict (branch_name, bill_date, bill_no, item_code, line_seq)
    do update set
      total_quantity     = excluded.total_quantity,
      gross_amount       = excluded.gross_amount,
      net_amount          = excluded.net_amount,
      agent_name           = excluded.agent_name,
      scheme_name            = excluded.scheme_name,
      scheme_group_name       = excluded.scheme_group_name,
      bill_time                = excluded.bill_time,
      shade_name                = excluded.shade_name,
      pack_size                  = excluded.pack_size,
      category                    = excluded.category,
      subcategory                  = excluded.subcategory,
      season                        = excluded.season,
      market_segment                = excluded.market_segment,
      gender                          = excluded.gender,
      size_group                      = excluded.size_group,
      mrp                               = excluded.mrp,
      _airbyte_extracted_at     = now()
    returning 1
  )
  select count(*) into v_count from ins;

  update ops.erp_report_uploads set status = 'processed', notes = null where id = p_upload_id;

  return v_count;
end;
$$;

revoke all on function ops.fn_process_sale_upload from public, anon;
grant execute on function ops.fn_process_sale_upload to authenticated;
