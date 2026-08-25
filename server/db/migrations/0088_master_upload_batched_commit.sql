-- =============================================================================
-- 0088 · Batch ops.fn_process_master_upload so a large master file can commit
-- =============================================================================
-- Confirmed live 2026-08-25: a 93,300-row master upload's "Commit" got stuck
-- showing "Committing…" forever. Timed the exact same upsert shape directly
-- against Postgres (bypassing PostgREST/Vercel): 52.8 seconds for the DB
-- write alone. Add file download + XLSX parse + the PostgREST round-trip on
-- top of that, and the whole request comfortably exceeds Vercel's 60s
-- Hobby-plan function ceiling (see 0084-0087's own maxDuration notes) — the
-- function gets killed mid-request, the client gets back a non-JSON error
-- page, and (a separate bug, fixed in the same app deploy as this
-- migration) the commit button's missing catch block left the UI stuck on
-- "Committing…" with no way to tell it had actually failed.
--
-- Fix: the commit route now sends the parsed rows in BATCHES (the browser
-- drives a loop of smaller commit requests, each with its own fresh 60s
-- budget), rather than one 93K-row request. The upload should only be
-- marked 'processed' once, on the LAST batch — hence the new
-- p_mark_processed parameter. Existing behavior (single call, always marks
-- processed) is preserved by defaulting it true, so any other caller of
-- this function is unaffected.
--
-- Adding a parameter changes this function's signature — Postgres treats
-- foo(a,b,c) and foo(a,b,c,d) as genuinely different overloads, so
-- CREATE OR REPLACE would add a second function rather than replacing the
-- first. Drop the old 3-arg signature explicitly.

drop function if exists ops.fn_process_master_upload(uuid, jsonb, text);

create function ops.fn_process_master_upload(
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
      item_code text, item_name text, shade_name text, pack_size text,
      category text, subcategory text, season text, market_segment text,
      gender text, size_group text, size text, mrp numeric
    )
  ),
  upserted as (
    insert into raw_logic.item_master
      (item_code, item_name, shade_name, pack_size, category, subcategory,
       season, market_segment, gender, size_group, size, mrp, source_file, updated_at)
    select item_code, item_name, shade_name, pack_size, category, subcategory,
           season, market_segment, gender, size_group, size, mrp, p_source_file, now()
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
      size           = coalesce(excluded.size,            raw_logic.item_master.size),
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

revoke all on function ops.fn_process_master_upload(uuid, jsonb, text, boolean) from public, anon;
grant execute on function ops.fn_process_master_upload(uuid, jsonb, text, boolean) to authenticated;

notify pgrst, 'reload schema';
