-- =============================================================================
-- 0022 · ERP report uploads — offline-mode Excel intake, storage only
-- =============================================================================
-- Logic ERP's SQL Server (192.168.1.12) isn't reliably reachable from this
-- app yet (LAN-only box, no live connector built — see 0021's header and
-- project notes on 2026-08-12). Until that connector exists, HO Admin /
-- Super Admin upload the three reports they already pull from Logic ERP by
-- hand — Sale, Stock, Scheme — as Excel files, one row per upload here.
--
-- Same deliberate scope limit as 0018_incentive_target_imports: this table
-- only records that a file arrived and where it's stored. Parsing these into
-- raw_logic.sales_transactions / a stock table / a scheme table is a
-- separate piece of work that needs real column samples from the actual
-- files first — raw_logic.sales_transactions' existing shape is explicitly
-- flagged UNVERIFIED/guessed in migration 0004, and this table must not
-- repeat that mistake for stock/scheme.

create table ops.erp_report_uploads (
  id            uuid primary key default gen_random_uuid(),
  report_type   text not null check (report_type in ('sale', 'stock', 'scheme')),
  file_name     text not null,
  storage_path  text not null,          -- path within the erp-reports bucket
  uploaded_by   uuid references core.profiles (user_id),
  uploaded_at   timestamptz not null default now(),
  status        text not null default 'uploaded' check (status in ('uploaded', 'processed', 'failed')),
  notes         text
);

create index erp_report_uploads_type_uploaded_at_idx
  on ops.erp_report_uploads (report_type, uploaded_at desc);

alter table ops.erp_report_uploads enable row level security;

create policy erp_report_uploads_rw on ops.erp_report_uploads for all
  using (core.fn_user_role() in ('ho_admin', 'super_admin'))
  with check (core.fn_user_role() in ('ho_admin', 'super_admin'));

grant select, insert, update on ops.erp_report_uploads to authenticated;

-- No storage.buckets/storage.objects here, same reasoning as 0018 — file
-- storage (MinIO on self-hosted) is the API service's concern, not the
-- database's.
