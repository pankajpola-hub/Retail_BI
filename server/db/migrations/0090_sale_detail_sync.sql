-- =============================================================================
-- 0090 · Live sale_detail sync — source marker + upsert/log RPCs
-- =============================================================================
-- New second, live source for EBO Sale data (the ERP's own sale_detail view
-- on a separate Supabase project, refreshed nightly at 20:30 — see
-- web/lib/salesSource/client.ts, built and verified 2026-08-26). Pankaj's
-- decision: manual Excel upload STAYS as a fallback (unchanged, this
-- migration touches nothing about it), and the sync only ever writes the
-- CURRENT fiscal year onward — FY24-25/FY25-26 rows already in
-- raw_logic.sales_transactions from Excel uploads are never touched. The
-- sync's own fin_year filter (in the cron route, not here) is the actual
-- safety rail for that; `source` below is just a visible marker of which
-- path wrote a row, not an enforcement mechanism.
--
-- Grain and upsert key match the EXISTING Excel-upload path exactly (0024/
-- 0089's `unique (branch_name, bill_date, bill_no, item_code, line_seq)`,
-- unchanged) — this is a second WRITER into the same table via a distinct
-- RPC, not a new table or a schema change to how the rest of the app reads
-- sales data. sales.vw_sale_transactions_export (0086) already derives
-- bill_type from bill_no's own SB-/RB- substring (not a stored column) and
-- joins raw_logic.item_master for item_name/shade_name/season/
-- market_segment/gender/size_group/mrp (not from sales_transactions' own
-- copies) — so as long as bill_no and item_code (barcode) are correct here,
-- every existing downstream consumer (Replenishment, Sale vs Stock Mix,
-- Network) keeps working unchanged, no view edits needed.
--
-- fn_upsert_synced_sale_rows is a SIBLING to ops.fn_process_sale_upload
-- (0089), not a replacement or an added parameter to it: that function is
-- gated to a human upload session (checks core.fn_user_role(), tied to an
-- ops.erp_report_uploads row) and granted to `authenticated`. This sync has
-- no user session at all — it runs from a Vercel Cron route authenticated
-- by a shared secret, using the service-role admin client (same posture as
-- api/cron/uniware-sync/route.ts) — so it's granted to `service_role` only,
-- same as ops.fn_upsert_uniware_orders (0065).

alter table raw_logic.sales_transactions add column if not exists source text;
comment on column raw_logic.sales_transactions.source is
  'NULL/unset for the original Excel-upload path (unchanged, still the fallback). ''sale_detail_sync'' for rows written by api/cron/sale-detail-sync — the live ERP source, scoped to the current fiscal year only. A row''s presence here doesn''t mean the OTHER path never wrote it; on a real conflict the most recent writer''s source wins, same as every other column ON CONFLICT DO UPDATE already does.';

-- -----------------------------------------------------------------------------
-- raw_logic.sale_detail_sync_runs — one row per cron invocation
-- -----------------------------------------------------------------------------
-- Mirrors raw_uniware.sync_runs (0068) shape/reasoning exactly: nothing
-- alerts on a 200 response with a non-empty errors array, so a silently
-- failing nightly sync needs to be visible without querying Postgres
-- directly. Lives in raw_logic (not a new schema) since sales_transactions
-- already is raw_logic's — same "zero grants to authenticated/anon,
-- service_role only, reachable through SECURITY DEFINER functions" posture
-- 0001 established for the whole schema.
create table raw_logic.sale_detail_sync_runs (
  id              bigint generated always as identity primary key,
  started_at      timestamptz not null,
  finished_at     timestamptz,
  fin_year_synced integer,
  rows_upserted   integer not null default 0,
  errors          jsonb not null default '[]'::jsonb,
  success         boolean,
  _created_at     timestamptz not null default now()
);

comment on table raw_logic.sale_detail_sync_runs is
  'One row per web/app/api/cron/sale-detail-sync GET invocation. Written by ops.fn_log_sale_detail_sync_run at the end of the run.';
comment on column raw_logic.sale_detail_sync_runs.success is
  'True only when errors is empty for the whole run. Null would mean the route crashed before writing this row at all (e.g. auth rejected, or an unhandled exception outside the per-batch try/catch).';

create index sale_detail_sync_runs_started_at_idx on raw_logic.sale_detail_sync_runs (started_at desc);

grant select, insert, update, delete on raw_logic.sale_detail_sync_runs to service_role;

-- -----------------------------------------------------------------------------
-- ops.fn_upsert_synced_sale_rows — write door, service_role only
-- -----------------------------------------------------------------------------
-- No core.fn_user_role() check (unlike ops.fn_process_sale_upload) — there
-- is no user session to check; the cron route's own CRON_SECRET bearer
-- check is the access gate, same as api/cron/uniware-sync's own RPCs.
--
-- Column set deliberately smaller than fn_process_sale_upload's (no
-- pack_size, no size_group): sale_detail has no equivalent for either, and
-- vw_sale_transactions_export doesn't read size_group from
-- sales_transactions anyway (it joins item_master instead, per this
-- migration's own header) — leaving a column out of the UPDATE SET list
-- leaves any existing value alone rather than nulling it, so this can't
-- clobber a size_group an Excel upload already set for the same key.
create function ops.fn_upsert_synced_sale_rows(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = core, raw_logic, ops, extensions, pg_temp
as $$
declare
  v_count integer;
begin
  with parsed as (
    select *
    from jsonb_to_recordset(p_rows) as x(
      branch_name text, bill_date text, bill_no text, item_code text,
      total_quantity numeric, gross_amount numeric, net_amount numeric,
      agent_name text, scheme_name text, scheme_group_name text, bill_time text,
      shade_name text, category text, subcategory text,
      season text, market_segment text, gender text, mrp numeric,
      line_seq integer
    )
  ),
  ins as (
    insert into raw_logic.sales_transactions
      (branch_name, bill_date, bill_no, item_code, total_quantity, gross_amount, net_amount,
       agent_name, scheme_name, scheme_group_name, bill_time,
       shade_name, category, subcategory, season, market_segment, gender, mrp,
       line_seq, source)
    select branch_name, bill_date, bill_no, item_code, total_quantity, gross_amount, net_amount,
           agent_name, scheme_name, scheme_group_name, bill_time,
           shade_name, category, subcategory, season, market_segment, gender, mrp,
           line_seq, 'sale_detail_sync'
    from parsed
    on conflict (branch_name, bill_date, bill_no, item_code, line_seq)
    do update set
      total_quantity        = excluded.total_quantity,
      gross_amount          = excluded.gross_amount,
      net_amount             = excluded.net_amount,
      agent_name              = excluded.agent_name,
      scheme_name               = excluded.scheme_name,
      scheme_group_name          = excluded.scheme_group_name,
      bill_time                    = excluded.bill_time,
      shade_name                    = excluded.shade_name,
      category                       = excluded.category,
      subcategory                     = excluded.subcategory,
      season                            = excluded.season,
      market_segment                     = excluded.market_segment,
      gender                               = excluded.gender,
      mrp                                    = excluded.mrp,
      source                                  = excluded.source,
      _airbyte_extracted_at = now()
    returning 1
  )
  select count(*) into v_count from ins;

  return v_count;
end;
$$;

revoke all on function ops.fn_upsert_synced_sale_rows(jsonb) from public, anon, authenticated;
grant execute on function ops.fn_upsert_synced_sale_rows(jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- ops.fn_log_sale_detail_sync_run — write door for the run log
-- -----------------------------------------------------------------------------
create function ops.fn_log_sale_detail_sync_run(
  p_started_at    timestamptz,
  p_finished_at   timestamptz,
  p_fin_year      integer,
  p_rows_upserted integer,
  p_errors        jsonb,
  p_success       boolean
)
returns bigint
language plpgsql
security definer
set search_path = raw_logic, ops, extensions, pg_temp
as $$
declare
  v_id bigint;
begin
  insert into raw_logic.sale_detail_sync_runs
    (started_at, finished_at, fin_year_synced, rows_upserted, errors, success)
  values
    (p_started_at, p_finished_at, p_fin_year, p_rows_upserted, coalesce(p_errors, '[]'::jsonb), p_success)
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function ops.fn_log_sale_detail_sync_run(timestamptz, timestamptz, integer, integer, jsonb, boolean) from public, anon, authenticated;
grant execute on function ops.fn_log_sale_detail_sync_run(timestamptz, timestamptz, integer, integer, jsonb, boolean) to service_role;

-- -----------------------------------------------------------------------------
-- ops.fn_sale_detail_sync_runs — read door, for a future status route
-- -----------------------------------------------------------------------------
create function ops.fn_sale_detail_sync_runs(p_limit integer default 20)
returns table(
  id              bigint,
  started_at      timestamptz,
  finished_at     timestamptz,
  fin_year_synced integer,
  rows_upserted   integer,
  errors          jsonb,
  success         boolean
)
language sql
security definer
set search_path = raw_logic, ops, extensions, pg_temp
as $$
  select id, started_at, finished_at, fin_year_synced, rows_upserted, errors, success
  from raw_logic.sale_detail_sync_runs
  order by started_at desc
  limit p_limit;
$$;

revoke all on function ops.fn_sale_detail_sync_runs(integer) from public, anon;
grant execute on function ops.fn_sale_detail_sync_runs(integer) to authenticated, service_role;

notify pgrst, 'reload schema';
