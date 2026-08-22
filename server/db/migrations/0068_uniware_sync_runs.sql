-- =============================================================================
-- 0068 · raw_uniware.sync_runs — cron invocation log + ops.fn_* read/write door
-- =============================================================================
-- Problem this fixes: web/app/api/cron/uniware-sync/route.ts already builds a
-- per-invocation `errors: string[]` array (0063/0065's header sync + item
-- enrichment phases both catch-and-collect rather than throw), but nothing
-- reads that response today — Vercel Cron doesn't alert on a 200 with a
-- non-empty `errors` array, and a silently-failing daily sync would go
-- unnoticed indefinitely. One row per invocation here, written at the end of
-- the GET handler, makes "did yesterday's sync succeed" answerable without
-- querying Postgres directly (see the new status route).
--
-- Same posture as raw_uniware's existing tables (0063's header): zero grants
-- to anon/authenticated, service_role only. And same reason 0065 exists at
-- all rather than granting PostgREST access directly: raw_uniware is
-- deliberately NOT in Supabase's "Exposed schemas" list, so the app's
-- supabase-js admin client (lib/data/admin.ts, PostgREST-backed) cannot see
-- this table by name — reads and writes both go through SECURITY DEFINER
-- functions in `ops` (already exposed), exactly like
-- ops.fn_upsert_uniware_orders / ops.fn_uniware_orders_needing_items.
--
-- Learned the hard way on 0061/0062 (see 0062's header) and reconfirmed by
-- 0063: Supabase's service_role has BYPASSRLS, but that only waives RLS
-- POLICIES, not ordinary table-level GRANT privileges — an insert attempt
-- against an ungranted table fails with "permission denied" regardless of
-- BYPASSRLS. Granting explicitly below from the start.

create table raw_uniware.sync_runs (
  id                       bigint generated always as identity primary key,
  started_at               timestamptz not null,
  finished_at              timestamptz,
  header_orders_upserted   integer not null default 0,
  item_orders_processed    integer not null default 0,
  item_orders_failed       integer not null default 0,
  errors                   jsonb not null default '[]'::jsonb,
  success                  boolean,
  _created_at              timestamptz not null default now()
);

comment on table raw_uniware.sync_runs is
  'One row per web/app/api/cron/uniware-sync GET invocation. Written by ops.fn_log_uniware_sync_run at the end of the run (header sync + item enrichment phases already ran and collected their own errors by then) so a failing/degraded cron run is visible without querying Postgres directly — see the /api/cron/uniware-sync/status route.';
comment on column raw_uniware.sync_runs.success is
  'True only when errors is empty for the whole run. Null would mean the route crashed before writing this row at all (e.g. auth rejected, or an unhandled exception outside the per-phase try/catch) — a gap distinguishable from a logged-but-recorded failure.';
comment on column raw_uniware.sync_runs.errors is
  'Verbatim copy of the route''s in-memory errors: string[] (0063/0065''s header + item sync phases each catch-and-collect rather than throw) — one string per failed chunk/order, human-readable, not machine-parsed.';

create index sync_runs_started_at_idx on raw_uniware.sync_runs (started_at desc);

-- -----------------------------------------------------------------------------
-- Grants — service_role only, matching raw_uniware's existing tables exactly
-- -----------------------------------------------------------------------------
grant select, insert, update, delete on raw_uniware.sync_runs to service_role;

-- No RLS enabled here, matching raw_uniware.sale_orders/sale_order_items
-- (0063) — reachable only through the service-role sync job and the
-- SECURITY DEFINER functions below, never through direct authenticated/anon
-- access.

-- -----------------------------------------------------------------------------
-- ops.fn_log_uniware_sync_run — write door (called once per cron invocation)
-- -----------------------------------------------------------------------------
create or replace function ops.fn_log_uniware_sync_run(
  p_started_at              timestamptz,
  p_finished_at             timestamptz,
  p_header_orders_upserted  integer,
  p_item_orders_processed   integer,
  p_item_orders_failed      integer,
  p_errors                  jsonb,
  p_success                 boolean
)
returns bigint
language plpgsql
security definer
set search_path = raw_uniware, ops, extensions, pg_temp
as $$
declare
  v_id bigint;
begin
  insert into raw_uniware.sync_runs
    (started_at, finished_at, header_orders_upserted, item_orders_processed,
     item_orders_failed, errors, success)
  values
    (p_started_at, p_finished_at, p_header_orders_upserted, p_item_orders_processed,
     p_item_orders_failed, coalesce(p_errors, '[]'::jsonb), p_success)
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function ops.fn_log_uniware_sync_run(timestamptz, timestamptz, integer, integer, integer, jsonb, boolean) from public, anon, authenticated;
grant execute on function ops.fn_log_uniware_sync_run(timestamptz, timestamptz, integer, integer, integer, jsonb, boolean) to service_role;

-- -----------------------------------------------------------------------------
-- ops.fn_uniware_sync_runs — read door (status route + any future monitoring)
-- -----------------------------------------------------------------------------
create or replace function ops.fn_uniware_sync_runs(p_limit integer default 20)
returns table(
  id                       bigint,
  started_at               timestamptz,
  finished_at              timestamptz,
  header_orders_upserted   integer,
  item_orders_processed    integer,
  item_orders_failed       integer,
  errors                   jsonb,
  success                  boolean
)
language sql
security definer
set search_path = raw_uniware, ops, extensions, pg_temp
as $$
  select id, started_at, finished_at, header_orders_upserted, item_orders_processed,
         item_orders_failed, errors, success
  from raw_uniware.sync_runs
  order by started_at desc
  limit p_limit;
$$;

revoke all on function ops.fn_uniware_sync_runs(integer) from public, anon, authenticated;
grant execute on function ops.fn_uniware_sync_runs(integer) to service_role;

notify pgrst, 'reload schema';
