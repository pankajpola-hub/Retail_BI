-- =============================================================================
-- 0054 · raw_logic.item_master — item-attribute master keyed by item_code
-- =============================================================================
-- Adds a FOURTH ERP report type, 'master', to the existing offline-mode intake
-- (0022 storage + 0024 validate -> preview -> commit pipeline), and the table
-- it lands in.
--
-- WHY: real Logic ERP Sale exports do not always carry the per-line item
-- attribute columns migration 0030 added (category, subcategory, gender,
-- season, size_group, shade_name, market_segment, pack_size, mrp). When those
-- columns are absent the corresponding raw_logic.sales_transactions columns
-- land NULL, and the Targets / Replenishment / Stock filters that key on
-- gender and category silently lose those rows. An item-master workbook keyed
-- on item_code supplies those attributes independently of whatever any single
-- sale export happened to include.
--
-- WHAT THIS MIGRATION DOES *NOT* DO — read this before assuming otherwise:
-- it does NOT modify any existing view. sales.vw_ebo_sales_lines,
-- sales.vw_stock_with_scheme, and every other existing view are left exactly
-- as they are. Enriching sale lines from item_master (e.g. coalescing a null
-- sales_transactions.gender from item_master.gender) would change existing
-- business logic, and per Objective.md that requires explicit approval first.
-- This migration ONLY lands the data and the pipeline to load it; wiring it
-- into any read path is a separate, later decision.
--
-- Grain: one row per item_code, last write wins. This is a master/dimension
-- table, not a snapshot and not a transaction log — a re-upload UPSERTs
-- (0024's scheme_lookup replaces wholesale; item_master deliberately does not,
-- so a partial master file tops up rather than wipes out attributes for items
-- it doesn't mention). source_file records which workbook last wrote each row.

-- -----------------------------------------------------------------------------
-- The table
-- -----------------------------------------------------------------------------
create table raw_logic.item_master (
  item_code        text primary key,
  item_name        text,
  shade_name       text,
  pack_size        text,
  category         text,
  subcategory      text,
  season           text,
  market_segment   text,
  gender           text,
  size_group       text,
  mrp              numeric,
  source_file      text,        -- file_name of the upload that last wrote this row
  updated_at       timestamptz not null default now()
);

-- Attribute lookups are the whole point of this table; item_code is already
-- the PK (so item_code joins are covered). These two mirror
-- stock_snapshot_gender_size_group_idx's reasoning — gender/category are the
-- filter columns the Targets/Replenishment/Stock pages key on.
create index item_master_gender_idx   on raw_logic.item_master (gender);
create index item_master_category_idx on raw_logic.item_master (category, subcategory);

comment on table raw_logic.item_master is
  'Item attributes keyed by item_code, UPSERT-on-reupload (last write wins). Fills attributes a Sale export may omit. Deliberately NOT joined into any existing view — see 0054 header.';
comment on column raw_logic.item_master.source_file is
  'file_name of the ops.erp_report_uploads row that last wrote this row. No FK: upload rows are pruned by the keep-latest-only retention rule, and losing provenance text must not block that delete.';

-- -----------------------------------------------------------------------------
-- RLS + grants: identical posture to the other raw_logic ingest tables
-- -----------------------------------------------------------------------------
-- Verified live before writing this: raw_logic.sales_transactions,
-- raw_logic.stock_snapshot and raw_logic.scheme_lookup all have
-- relrowsecurity = false and ZERO grants to anyone but their owner (postgres).
-- raw_logic keeps zero direct grants to authenticated/anon (0001's rule,
-- restated in 0024's header and in HANDOFF.md's note about why
-- security_invoker = on is incompatible with this app). item_master follows
-- that exactly: no RLS policies, no grants, no `authenticated` access.
--
-- The ONLY door in is the SECURITY DEFINER function below, which runs as the
-- table's owner and does its own ho_admin/super_admin role check — the same
-- pattern ops.fn_process_sale/stock/scheme_upload use. Confirmed by reading
-- web/app/api/data-upload/process/[id]/commit/route.ts: every commit branch
-- uses the ordinary user-scoped client from lib/data/client.ts and an
-- .rpc(...) call, NOT the service-role admin client (lib/data/admin.ts is
-- restricted to user provisioning + the integrations credential write). This
-- migration keeps that true for 'master' too.

-- -----------------------------------------------------------------------------
-- Widen the uploads report_type CHECK to include 'master'
-- -----------------------------------------------------------------------------
-- A CHECK constraint cannot be altered in place — it must be dropped and
-- recreated. Constraint name verified live against pg_constraint:
-- erp_report_uploads_report_type_check, currently
-- CHECK (report_type = ANY (ARRAY['sale','stock','scheme'])).
alter table ops.erp_report_uploads
  drop constraint if exists erp_report_uploads_report_type_check;

alter table ops.erp_report_uploads
  add constraint erp_report_uploads_report_type_check
  check (report_type in ('sale', 'stock', 'scheme', 'master'));

-- -----------------------------------------------------------------------------
-- ops.fn_process_master_upload — the only door into raw_logic.item_master
-- -----------------------------------------------------------------------------
-- Same shape as 0024's three processing functions: role-gated to
-- ho_admin/super_admin independently of whatever the Next.js route already
-- checked, writes in one statement inside the function's transaction, then
-- marks the upload row 'processed'. p_rows is the already-parsed,
-- already-validated row set from web/lib/erpReports/parseMasterWorkbook.ts.
--
-- Returns jsonb rather than 0024's integer because the master flow reports
-- inserted vs updated separately — on a master file the split is the useful
-- signal ("did this file add 40 new items or restate 12000 existing ones?").
-- `xmax = 0` on the RETURNING row is the standard way to tell an INSERT from
-- an ON CONFLICT DO UPDATE inside a single upsert statement.
--
-- Attribute columns use coalesce(excluded.x, existing.x): a master file that
-- leaves a cell blank must not ERASE an attribute an earlier file supplied.
-- Blank means "not stated here", not "clear this". The parser already
-- normalises empty cells to null, so this is the single place that decision
-- lives.
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
      gender text, size_group text, mrp numeric
    )
  ),
  upserted as (
    insert into raw_logic.item_master
      (item_code, item_name, shade_name, pack_size, category, subcategory,
       season, market_segment, gender, size_group, mrp, source_file, updated_at)
    select item_code, item_name, shade_name, pack_size, category, subcategory,
           season, market_segment, gender, size_group, mrp, p_source_file, now()
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

notify pgrst, 'reload schema';
