-- =============================================================================
-- 0071 · Phase 5 (Track B): scheduled exports (blueprint's "workspace
--        maturity" gap). Additive only.
-- =============================================================================
-- One table, one owner-only RLS posture — the exact same shape as
-- workspace.workspaces (0049): owner_id = core.current_user_id(), full CRUD
-- for the owner, nothing visible to anyone else. No sharing/permissions
-- layer here either, for the same reason 0049 didn't build one for
-- workspaces at this phase: there is exactly one principal (the owner) who
-- has any business reading or writing a row.
--
-- Deliberately narrow, matching the de-scoped Phase 5 plan (Explore passes
-- confirmed "saved views" already exists as the Workspace Builder — the
-- real remaining gap was just scheduled re-runs of the three existing
-- synchronous XLSX-download reports, not new report logic or a filter
-- engine):
--   - export_type is a closed set matching the three existing
--     app/api/*/download (or /audit-report) routes: replenishment,
--     footfall_completeness, targets_audit. No store/date/filter columns —
--     the scheduled run reuses each report's own sensible "whole scope"
--     default rather than persisting a second copy of each page's filter
--     state (see web/lib/exports/scheduledExports.ts for what each default
--     actually is).
--   - frequency is 'daily' | 'weekly'. The cron route (running once daily,
--     see vercel.json) decides what's actually due by comparing
--     last_run_at's age against the frequency, not by scheduling a separate
--     trigger per cadence.
--   - last_file_path stores the Supabase Storage object path of the most
--     recent output (bucket: 'scheduled-exports', see
--     lib/storage/supabase.ts's existing saveObjectFile/getDownloadUrl,
--     already used by the ERP report upload/download routes) — the
--     Workspace UI turns this into a signed download URL on read, it is
--     never served directly.
-- =============================================================================

create table ops.scheduled_exports (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references core.profiles(user_id),
  export_type    text not null check (export_type in ('replenishment', 'footfall_completeness', 'targets_audit')),
  frequency      text not null check (frequency in ('daily', 'weekly')),
  last_run_at    timestamptz,
  last_file_path text,
  created_at     timestamptz not null default now()
);

create index idx_scheduled_exports_owner on ops.scheduled_exports (owner_id);
-- The cron route's "find due schedules" query filters on this directly
-- (last_run_at is null, or older than the frequency's window) — see
-- runDueScheduledExports.
create index idx_scheduled_exports_due on ops.scheduled_exports (frequency, last_run_at);

alter table ops.scheduled_exports enable row level security;

-- Owner-only, full stop — same core.current_user_id() GUC-based identity
-- function every other RLS policy in this app uses (0003), same exact
-- policy shape as workspaces_owner_all (0049).
create policy scheduled_exports_owner_all on ops.scheduled_exports
  for all
  using (owner_id = core.current_user_id())
  with check (owner_id = core.current_user_id());

grant select, insert, update, delete on ops.scheduled_exports to authenticated;
grant all on ops.scheduled_exports to service_role;

notify pgrst, 'reload schema';
