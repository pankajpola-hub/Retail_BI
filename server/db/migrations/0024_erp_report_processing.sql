-- =============================================================================
-- 0024 · Sale/Stock/Scheme upload processing — parse-and-commit pipeline
-- =============================================================================
-- Builds the ONGOING processing step that 0022's header explicitly deferred:
-- "Parsing these into raw_logic.sales_transactions / a stock table / a scheme
-- table is a separate piece of work that needs real column samples from the
-- actual files first." Real files have now been uploaded to production and
-- verified column-by-column (row counts, blank/total rows, distinct value
-- sets) against the shapes described here — see web/lib/erpReports/*.ts for
-- the parsers built from that verification.
--
-- Shape of the pipeline, matching 0018's "validate -> preview -> commit,
-- never a direct parse-and-insert on upload" convention:
--   1. Browser downloads the already-uploaded file from MinIO (via the
--      existing /api/data-upload/download/[id] redirect) — no new download
--      path needed.
--   2. POST /api/data-upload/process/[id]/preview parses it server-side with
--      the `xlsx` package and returns row counts + a sample + any row-level
--      errors, writing nothing.
--   3. POST /api/data-upload/process/[id]/commit re-parses the same file and
--      calls the SECURITY DEFINER function below to actually write, then
--      marks ops.erp_report_uploads.status = 'processed' (or 'failed' with
--      a note).
--
-- Why SECURITY DEFINER functions instead of the service-role admin client:
-- lib/data/admin.ts's header explicitly restricts createAdminClient() to
-- "only user provisioning and the integrations credential write" — this
-- follows the OTHER established pattern instead (see core.fn_user_role()
-- policies throughout: ho_admin/super_admin check done INSIDE a definer
-- function, granted to `authenticated`, same as every RLS policy in this
-- project already does it declaratively). raw_logic keeps zero direct
-- grants to authenticated/anon (0001's rule), unchanged by this migration —
-- these functions are the only door into it.

-- -----------------------------------------------------------------------------
-- raw_logic.sales_transactions: add the natural key the table never had.
-- -----------------------------------------------------------------------------
-- Verified against the real Sale report (20976 real data rows, i.e. minus
-- the merged title row, header row, one blank-branch row, and the two
-- summary rows "BRANCH WISE TOTALS"/"GRAND TOTALS"): branch_name + bill_date
-- + bill_no + item_code is ALMOST unique but not quite — 9 exact-duplicate
-- line pairs exist in the real file (same item rung up as two separate
-- qty=1 lines on the same bill, same bill_time, e.g. bill SB-428 on
-- 09/02/2025 carries item 8905385425719 twice). line_seq disambiguates:
-- 1, 2, ... per repeat of the same (branch, date, bill, item) combo, counted
-- in the order the rows appear in the source file/table. This makes
-- re-uploading the SAME file idempotent (same row order -> same line_seq ->
-- clean upsert, no dupes) without collapsing genuine repeat-scan lines into
-- one row.
--
-- Backfill assumption for the ~20953 rows already loaded via the one-time
-- raw_logic_data.sql dump: ctid (physical insert order) is used as a stand-in
-- for original file row order, since the dump was a straight sequential
-- INSERT from the same file. Checked live: the existing table has the exact
-- same 9 duplicate (branch,date,bill,item) keys as the current real file, at
-- the same bill numbers — strong evidence the dump order already matches
-- file order, so re-uploading this same historical file through the new
-- pipeline should upsert cleanly rather than duplicate. This is an inference
-- from matching duplicate patterns, not a certainty for 100% of rows; if a
-- future full historical re-upload ever produces duplicate rows instead of
-- clean overwrites, that's the assumption to revisit first.
alter table raw_logic.sales_transactions add column if not exists line_seq integer;

with numbered as (
  select ctid, row_number() over (
    partition by branch_name, bill_date, bill_no, item_code
    order by ctid
  ) as rn
  from raw_logic.sales_transactions
  where line_seq is null
)
update raw_logic.sales_transactions t
set line_seq = n.rn
from numbered n
where t.ctid = n.ctid;

alter table raw_logic.sales_transactions alter column line_seq set not null;
alter table raw_logic.sales_transactions alter column line_seq set default 1;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sales_transactions_natural_key'
  ) then
    alter table raw_logic.sales_transactions
      add constraint sales_transactions_natural_key
      unique (branch_name, bill_date, bill_no, item_code, line_seq);
  end if;
end $$;

comment on column raw_logic.sales_transactions.line_seq is
  'Disambiguates true repeat lines (same branch+date+bill+item appearing more than once) so upserts stay idempotent per source-file row order. See 0024 header.';

-- -----------------------------------------------------------------------------
-- raw_logic.stock_snapshot — point-in-time replace, not additive
-- -----------------------------------------------------------------------------
-- Verified against the real Stock report (sheet "Report", header row 2,
-- 5182 real item rows after excluding the merged title row and the
-- "Branch Wise Totals"/"GRAND TOTALS" rows — closing-stock sum of the kept
-- rows, 5368, matches the file's own GRAND TOTALS value exactly). A stock
-- report is a snapshot, not a transaction log — each new upload REPLACES the
-- previous snapshot wholesale (delete-all + insert, inside one function
-- call/transaction) rather than accumulating forever. upload_id is kept
-- purely for traceability (which upload produced the current snapshot), not
-- as a dedupe key — there is intentionally never more than one "live"
-- snapshot.
create table raw_logic.stock_snapshot (
  id                     bigint generated always as identity primary key,
  upload_id              uuid references ops.erp_report_uploads (id),
  branch_name            text,
  godown_name            text,
  company_name           text,
  season                 text,
  market_segment         text,
  gender                 text,
  size_group             text,
  subcategory            text,
  micro_season           text,
  pricelist              text,
  item_code              text,
  additional_item_code   text,
  item_name              text,   -- "ITEM NAME W/O SHADE"
  shade_name             text,
  size                   text,
  closing_stock          numeric not null,
  packing                text,
  rate                   numeric,
  loaded_at              timestamptz not null default now()
);

create index stock_snapshot_item_code_idx on raw_logic.stock_snapshot (item_code);
create index stock_snapshot_gender_size_group_idx on raw_logic.stock_snapshot (gender, size_group);
create index stock_snapshot_branch_idx on raw_logic.stock_snapshot (branch_name);

comment on table raw_logic.stock_snapshot is
  'Full replace on every stock-report upload (delete-all + insert) — a snapshot, not a transaction log. See 0024 header.';

-- -----------------------------------------------------------------------------
-- raw_logic.scheme_lookup — item_code -> scheme, replace-on-reupload
-- -----------------------------------------------------------------------------
-- Verified against the real Scheme report (sheet "Sheet1", header row 1:
-- Barcode, Scheme; 12513 non-blank scheme rows out of 12514 data rows; zero
-- duplicate barcodes; the ONE real distinct scheme value present is
-- "FLAT 50% OFF"). Modeled per the task note: store the actual scheme name
-- and a derived discount_pct where parseable from the name (e.g. "FLAT 50%
-- OFF" -> 50), with is_discounted_50plus derived FROM that percentage where
-- possible. FALLBACK, clearly flagged as an assumption rather than a
-- certainty: when a scheme name doesn't parse into a fixed percentage (e.g.
-- "BUY 1 GET 1", "FESTIVE COMBO"), discount_pct is left NULL and
-- is_discounted_50plus falls back to "has any non-blank scheme name at all".
-- For the real data today every scheme is parseable and >=50%, so this
-- fallback path is untested against real data — worth confirming against
-- whatever the next scheme file actually contains.
create table raw_logic.scheme_lookup (
  item_code               text primary key,
  upload_id               uuid references ops.erp_report_uploads (id),
  scheme_name             text,
  discount_pct            numeric,          -- parsed from scheme_name where possible, e.g. 'FLAT 50% OFF' -> 50; NULL if unparseable
  is_discounted_50plus    boolean not null, -- Fresh/EOSS split per 0023's 50%-of-gross precedent
  loaded_at               timestamptz not null default now()
);

comment on table raw_logic.scheme_lookup is
  'Full replace on every scheme-report upload. is_discounted_50plus: discount_pct >= 50 where parseable from scheme_name, else falls back to "has a non-blank scheme" (assumption, see 0024 header — untested against real data since every current scheme is FLAT 50% OFF).';

-- -----------------------------------------------------------------------------
-- Processing functions — the only door into raw_logic for authenticated users
-- -----------------------------------------------------------------------------
-- Each: role-gated to ho_admin/super_admin (same set 0022's RLS policy uses),
-- writes in one statement/transaction, then marks the upload row processed.
-- p_rows is the already-parsed, already-validated row set as jsonb (built by
-- the matching parser in web/lib/erpReports/*.ts) — these functions trust
-- their caller's row shape but NOT the caller's role, which is checked here
-- independently of whatever the Next.js route already checked.

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
      line_seq integer
    )
  ),
  ins as (
    insert into raw_logic.sales_transactions
      (branch_name, bill_date, bill_no, item_code, total_quantity, gross_amount, net_amount,
       agent_name, scheme_name, scheme_group_name, bill_time, line_seq)
    select branch_name, bill_date, bill_no, item_code, total_quantity, gross_amount, net_amount,
           agent_name, scheme_name, scheme_group_name, bill_time, line_seq
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
      _airbyte_extracted_at     = now()
    returning 1
  )
  select count(*) into v_count from ins;

  update ops.erp_report_uploads set status = 'processed', notes = null where id = p_upload_id;

  return v_count;
end;
$$;

create or replace function ops.fn_process_stock_upload(p_upload_id uuid, p_rows jsonb)
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

  delete from raw_logic.stock_snapshot;

  insert into raw_logic.stock_snapshot
    (upload_id, branch_name, godown_name, company_name, season, market_segment, gender,
     size_group, subcategory, micro_season, pricelist, item_code, additional_item_code,
     item_name, shade_name, size, closing_stock, packing, rate)
  select p_upload_id, branch_name, godown_name, company_name, season, market_segment, gender,
         size_group, subcategory, micro_season, pricelist, item_code, additional_item_code,
         item_name, shade_name, size, closing_stock, packing, rate
  from jsonb_to_recordset(p_rows) as x(
    branch_name text, godown_name text, company_name text, season text, market_segment text,
    gender text, size_group text, subcategory text, micro_season text, pricelist text,
    item_code text, additional_item_code text, item_name text, shade_name text, size text,
    closing_stock numeric, packing text, rate numeric
  );

  get diagnostics v_count = row_count;

  update ops.erp_report_uploads set status = 'processed', notes = null where id = p_upload_id;

  return v_count;
end;
$$;

create or replace function ops.fn_process_scheme_upload(p_upload_id uuid, p_rows jsonb)
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

  delete from raw_logic.scheme_lookup;

  insert into raw_logic.scheme_lookup (upload_id, item_code, scheme_name, discount_pct, is_discounted_50plus)
  select p_upload_id, item_code, scheme_name, discount_pct, is_discounted_50plus
  from jsonb_to_recordset(p_rows) as x(
    item_code text, scheme_name text, discount_pct numeric, is_discounted_50plus boolean
  )
  on conflict (item_code) do update set
    upload_id             = excluded.upload_id,
    scheme_name            = excluded.scheme_name,
    discount_pct             = excluded.discount_pct,
    is_discounted_50plus      = excluded.is_discounted_50plus,
    loaded_at                  = now();

  get diagnostics v_count = row_count;

  update ops.erp_report_uploads set status = 'processed', notes = null where id = p_upload_id;

  return v_count;
end;
$$;

-- A failed commit (parse succeeded but the write threw, e.g. a stray
-- constraint violation) is recorded from the Next.js route via a plain
-- UPDATE against ops.erp_report_uploads — that table already grants
-- authenticated update access with the ho_admin/super_admin RLS policy
-- (0022), so no separate function is needed for the failure path.

revoke all on function ops.fn_process_sale_upload from public, anon;
revoke all on function ops.fn_process_stock_upload from public, anon;
revoke all on function ops.fn_process_scheme_upload from public, anon;
grant execute on function ops.fn_process_sale_upload to authenticated;
grant execute on function ops.fn_process_stock_upload to authenticated;
grant execute on function ops.fn_process_scheme_upload to authenticated;

-- raw_logic keeps zero direct grants to authenticated/anon, unchanged from
-- 0001 — select access for the new Stock Details page goes through a view,
-- not the raw tables, same discipline as sales.vw_ebo_sales_lines for sales.

-- -----------------------------------------------------------------------------
-- Read-side views for the Stock Details page
-- -----------------------------------------------------------------------------
-- Single join point: stock x scheme lookup -> Fresh/EOSS per row. Every
-- breakdown on the page (gender, size-group/age-segment, season, color,
-- size) filters/groups this view rather than re-deriving the join.
--
-- security_invoker = off, security_barrier = true — same reasoning as
-- 0015's fix for sales.vw_ebo_sales_lines: raw_logic keeps zero grants to
-- authenticated (0001), so a security_invoker view over it would fail for
-- every caller. This view runs as its owner instead. Unlike the sales view,
-- there is no per-store row filter to preserve here (stock isn't scoped to
-- individual stores the way sales lines are) — access control is entirely
-- at the page layer (ho_admin/super_admin only, enforced by requireRole in
-- the Stock Details route), same as every other HO-wide analytics view in
-- this app.
create or replace view sales.vw_stock_with_scheme
with (security_invoker = off, security_barrier = true) as
select
  ss.id,
  ss.branch_name,
  ss.godown_name,
  ss.company_name,
  ss.season,
  ss.market_segment,
  nullif(trim(ss.gender), '')       as gender,
  nullif(trim(ss.size_group), '')   as size_group,
  ss.subcategory,
  ss.item_code,
  ss.item_name,
  ss.shade_name,
  ss.size,
  ss.closing_stock,
  ss.rate,
  sl.scheme_name,
  sl.discount_pct,
  coalesce(sl.is_discounted_50plus, false) as is_eoss
from raw_logic.stock_snapshot ss
left join raw_logic.scheme_lookup sl on sl.item_code = ss.item_code;

comment on view sales.vw_stock_with_scheme is
  'Stock snapshot joined to the scheme lookup for Fresh/EOSS classification. Line with no scheme_lookup match is Fresh (is_eoss = false) by default.';

grant select on sales.vw_stock_with_scheme to authenticated;
