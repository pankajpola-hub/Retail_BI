-- =============================================================================
-- 0101 · Sale Summary — wholesale/distribution-channel sales
--        (raw_logic.channel_sales_summary + upload pipeline + page permission)
-- =============================================================================
-- New business view: agents / distributors / LFS (Shoppers Stop, Lifestyle) /
-- MBO / ecommerce marketplaces — a completely different vertical from the
-- EBO-retail-focused pages this app has built so far (/sales, /targets,
-- /stock-details, /movement). Data arrives as a monthly PRE-AGGREGATED Excel
-- upload (one row per branch x month x party x channel, already summed — not
-- a bill/line grain like raw_logic.sales_transactions).
--
-- Profiled against a real sample ("Sale Summary logic.xlsx", read locally,
-- never committed or referenced by path anywhere in this migration or the
-- app code that reads it): 8,146 rows, 22 distinct months Nov 2024 - Aug
-- 2026, 5 branches, 73 distinct Channel Name, 14 distinct Channel Type
-- (AGENT-WEST, LFS, MBO-SIS, DISTRIBUTOR-NORTH, ECOM-MKTPL-SOR, DIRECT
-- PARTY, BRAND OUTLETS, etc. — never hardcoded, always read from the data),
-- 3 distinct Channel Model, 817 distinct Party Name.
--
-- Grain / idempotency key: (branch_name, bill_month, party_name,
-- channel_name) — verified unique in the sample. A re-upload of the same
-- month UPSERTs (updates), never duplicates — same idempotent-upload
-- philosophy as ops.fn_process_master_upload / ops.fn_process_sale_upload.
--
-- channel_type/channel_model are functionally dependent on channel_name in
-- the sample (1:1) but are stored PER ROW anyway, not normalized into a
-- separate lookup table — this app's established convention for raw-upload
-- tables (raw_logic.sales_transactions denormalizes agent_name/scheme_name
-- onto every line the same way, rather than joining out to a dimension
-- table it doesn't have).
--
-- NET > GROSS in ~90% of rows in the profiled sample (network total: Net
-- ~₹221cr vs Gross ~₹209cr) — held true across both positive- and negative-
-- quantity rows, so this reads as a genuine business convention for this
-- channel (markup / GST-inclusive net, or similar), not a data error.
-- Nothing here "fixes" or rejects it — both figures are stored and surfaced
-- as-is; the /sale-summary page's Markup/Discount % KPI is what makes this
-- legible on screen (see that page's own comment for the sign convention).
-- =============================================================================

create table raw_logic.channel_sales_summary (
  id              bigint generated always as identity primary key,
  branch_name     text not null,
  -- First day of the month the source "BILL DATE" text (e.g. "December
  -- 2024" — a month name + year, NOT a real per-day date) resolves to. See
  -- web/lib/erpReports/parseChannelSummaryWorkbook.ts for that parse.
  bill_month      date not null,
  party_name      text not null,
  channel_name    text not null,
  channel_type    text,
  channel_model   text,
  total_quantity  numeric not null default 0,   -- can be negative (returns) — 604 of 8,146 sample rows were
  gross_amount    numeric not null default 0,   -- can be negative
  net_amount      numeric not null default 0,   -- can be negative; NET EXCEEDS GROSS for ~90% of rows here — see header, not a bug
  upload_id       uuid references ops.erp_report_uploads(id) on delete set null,
  source_file     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint channel_sales_summary_natural_key
    unique (branch_name, bill_month, party_name, channel_name)
);

create index channel_sales_summary_month_idx on raw_logic.channel_sales_summary (bill_month);
create index channel_sales_summary_channel_type_idx on raw_logic.channel_sales_summary (channel_type);
create index channel_sales_summary_party_idx on raw_logic.channel_sales_summary (party_name);

comment on table raw_logic.channel_sales_summary is
  'Monthly pre-aggregated wholesale/distribution-channel sales (agents, distributors, LFS, MBO, ecomm marketplaces) — a different business view from the EBO-retail tables. One row per (branch, month, party, channel), upsert-on-reupload via ops.fn_process_channel_summary_upload. See migration 0101 header for the net>gross data note.';
comment on column raw_logic.channel_sales_summary.bill_month is
  'First day of the month the source "BILL DATE" text (a month name + year, e.g. "December 2024") resolves to. Month-grain only — not a real per-day date.';
comment on column raw_logic.channel_sales_summary.upload_id is
  'The ops.erp_report_uploads row that (most recently) wrote this row. ON DELETE SET NULL, not a hard block — the keep-latest-only retention rule (cleanupOlderUploads, same posture as the "sale" report type) can prune old upload rows immediately since this table is accumulate-not-replace, exactly like raw_logic.sales_transactions.';

-- Same posture as every other raw_logic ingest table (0054's header, itself
-- citing 0001/0015/0024): zero RLS policies, zero grants to authenticated/
-- anon on the base table. The only door IN is the SECURITY DEFINER function
-- below; the only door OUT is the sales.vw_channel_sales_summary view
-- further down (security_invoker left at its default OFF — 0056's header
-- explains why: a plain view runs as its owner, so it can read a table
-- `authenticated` itself has no grant on, without needing security_invoker
-- at all).

-- -----------------------------------------------------------------------------
-- Widen the uploads report_type CHECK to include 'channel_summary'
-- -----------------------------------------------------------------------------
alter table ops.erp_report_uploads
  drop constraint if exists erp_report_uploads_report_type_check;

alter table ops.erp_report_uploads
  add constraint erp_report_uploads_report_type_check
  check (report_type in ('sale', 'stock', 'scheme', 'master', 'channel_summary'));

-- -----------------------------------------------------------------------------
-- ops.fn_process_channel_summary_upload — the only door into the table above
-- -----------------------------------------------------------------------------
-- Batched from day one (p_mark_processed, same shape 0088/0089 already
-- established for master/sale) even though the profiled sample (8,146 rows)
-- is well under one batch — a monthly re-upload growing past that over time
-- is exactly the failure mode 0088/0089 had to retrofit onto master/sale
-- after the fact; this new pipeline starts with the fix already in place.
create function ops.fn_process_channel_summary_upload(
  p_upload_id uuid,
  p_rows jsonb,
  p_source_file text,
  p_mark_processed boolean default true
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
      branch_name text, bill_month date, party_name text, channel_name text,
      channel_type text, channel_model text,
      total_quantity numeric, gross_amount numeric, net_amount numeric
    )
  ),
  upserted as (
    insert into raw_logic.channel_sales_summary
      (branch_name, bill_month, party_name, channel_name, channel_type, channel_model,
       total_quantity, gross_amount, net_amount, upload_id, source_file, updated_at)
    select branch_name, bill_month, party_name, channel_name, channel_type, channel_model,
           total_quantity, gross_amount, net_amount, p_upload_id, p_source_file, now()
    from parsed
    on conflict (branch_name, bill_month, party_name, channel_name) do update set
      channel_type    = excluded.channel_type,
      channel_model   = excluded.channel_model,
      total_quantity  = excluded.total_quantity,
      gross_amount    = excluded.gross_amount,
      net_amount      = excluded.net_amount,
      upload_id       = excluded.upload_id,
      source_file     = excluded.source_file,
      updated_at      = now()
    returning (xmax = 0) as was_insert
  )
  select
    count(*) filter (where was_insert),
    count(*) filter (where not was_insert)
  into v_inserted, v_updated
  from upserted;

  if p_mark_processed then
    update ops.erp_report_uploads set status = 'processed', notes = null where id = p_upload_id;
  end if;

  return jsonb_build_object(
    'inserted', coalesce(v_inserted, 0),
    'updated',  coalesce(v_updated, 0),
    'total',    coalesce(v_inserted, 0) + coalesce(v_updated, 0)
  );
end;
$$;

revoke all on function ops.fn_process_channel_summary_upload(uuid, jsonb, text, boolean) from public, anon;
grant execute on function ops.fn_process_channel_summary_upload(uuid, jsonb, text, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- sales.vw_channel_sales_summary — read path for the /sale-summary page
-- -----------------------------------------------------------------------------
-- Role-gated at the DB layer, not just the route (C-09 lesson, 2026-08-27:
-- sales.vw_sale_transactions_export / vw_stock_with_scheme were reachable
-- raw over PostgREST with no predicate of their own, bypassing whatever
-- role check the Next.js route did — see migration 0097's header for the
-- full story). This view has an even simpler answer than 0097's two: there
-- is exactly ONE known caller (the /sale-summary page) and its role list is
-- already fixed by this same migration's role_permissions seed just above
-- (ho_admin/regional_manager/super_admin), so the view checks that exact
-- list directly rather than the weaker "is not null" 0097 used where the
-- real caller set was more varied.
create view sales.vw_channel_sales_summary as
select
  id, branch_name, bill_month, party_name, channel_name, channel_type, channel_model,
  total_quantity, gross_amount, net_amount, created_at, updated_at
from raw_logic.channel_sales_summary
where core.fn_user_role() in ('ho_admin', 'regional_manager', 'super_admin');

comment on view sales.vw_channel_sales_summary is
  'Read path for /sale-summary (HQ-only wholesale/distribution-channel view). Role-gated directly (core.fn_user_role() in ho_admin/regional_manager/super_admin) rather than relying on the route layer alone — see C-09 (migration 0097) for why an unscoped grant to authenticated is not enough on its own. security_invoker left at its default OFF — see raw_logic.channel_sales_summary''s own comment.';

grant select on sales.vw_channel_sales_summary to authenticated;

-- -----------------------------------------------------------------------------
-- Permission system (0079) — new page key
-- -----------------------------------------------------------------------------
insert into core.feature_keys (key, page_key, label, action_class, is_page, enforced, sort_order) values
  ('sale-summary.view', 'sale-summary', 'Sale Summary', 'view', true, true, 120);

-- HQ-only / wholesale-distribution financial data — more sensitive than the
-- retail EBO numbers already shown on /sales, and not store-scoped the way
-- ebo_manager's own access is elsewhere (no core.fn_user_store_ids()
-- dependency here at all, this is a network-wide channel view). Same role
-- list /targets already uses minus ebo_manager (a store manager has no
-- reason to see agent/distributor/LFS/MBO/marketplace numbers): ho_admin,
-- regional_manager, super_admin. marketing is deliberately excluded too —
-- unlike /ecomm (Uniware, its own vertical marketing already owns), this is
-- wholesale/distribution financials, not a marketing-facing channel report.
insert into core.role_permissions (role, permission_key) values
  ('super_admin', 'sale-summary.view'),
  ('ho_admin', 'sale-summary.view'),
  ('regional_manager', 'sale-summary.view');

notify pgrst, 'reload schema';
