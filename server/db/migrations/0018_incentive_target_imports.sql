-- =============================================================================
-- 0018 · Incentive target import — upload provision only
-- =============================================================================
-- Day-wise qty/value targets per store, uploaded as an Excel file, for
-- incentive calculations. Parsing/validation is explicitly NOT built yet —
-- this migration only provides somewhere safe to land the file and a record
-- that it was uploaded. Follow the pattern in marketing.campaign_import_batches
-- when the actual parsing gets built: validate → preview → commit, never a
-- direct parse-and-insert on upload.

create table ops.incentive_target_imports (
  id            uuid primary key default gen_random_uuid(),
  file_name     text not null,
  storage_path  text not null,          -- path within the incentive-targets bucket
  uploaded_by   uuid references core.profiles (user_id),
  uploaded_at   timestamptz not null default now(),
  status        text not null default 'uploaded' check (status in ('uploaded', 'processed', 'failed')),
  notes         text
);

alter table ops.incentive_target_imports enable row level security;

create policy incentive_target_imports_rw on ops.incentive_target_imports for all
  using (core.fn_user_role() in ('ho_admin', 'super_admin'))
  with check (core.fn_user_role() in ('ho_admin', 'super_admin'));

grant select, insert, update on ops.incentive_target_imports to authenticated;

-- No storage.buckets/storage.objects here — that was Supabase Storage.
-- Self-hosted file storage (local disk or MinIO) is the API service's
-- responsibility, not the database's; storage_path above is just wherever
-- the API decides to put the file. Access control for "who can upload" is
-- already covered by the ho_admin/super_admin check in the API route itself
-- plus the RLS policy on this table.
