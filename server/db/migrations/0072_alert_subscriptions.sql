-- =============================================================================
-- 0072 · Threshold alerts: opt-in email digest of the Overview exception
--        feed (Phase 5's other deferred half, now that SMTP exists).
-- =============================================================================
-- One row per user (owner_id unique) — this is a single on/off + frequency
-- toggle, not a list of authored rules. The "rule" itself is fixed: whatever
-- lib/sales/exceptions.ts's computeStoreExceptions() already flags on the
-- caller's own /network page (per-store WoW sales decline past
-- threshold_pct), for that caller's own granted stores. Same owner-only RLS
-- shape as ops.scheduled_exports (0071) and workspace.workspaces (0049).

create table ops.alert_subscriptions (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null unique references core.profiles(user_id),
  frequency      text not null check (frequency in ('daily', 'weekly')),
  threshold_pct  numeric not null default -10,
  last_run_at    timestamptz,
  last_sent_at   timestamptz,
  created_at     timestamptz not null default now()
);

-- The alerts cron's "find due subscriptions" query filters on this directly
-- (last_run_at is null, or older than the row's own frequency window) — see
-- runDueAlerts.
create index idx_alert_subscriptions_due on ops.alert_subscriptions (frequency, last_run_at);

alter table ops.alert_subscriptions enable row level security;

create policy alert_subscriptions_owner_all on ops.alert_subscriptions
  for all
  using (owner_id = core.current_user_id())
  with check (owner_id = core.current_user_id());

grant select, insert, update, delete on ops.alert_subscriptions to authenticated;
grant all on ops.alert_subscriptions to service_role;

notify pgrst, 'reload schema';
