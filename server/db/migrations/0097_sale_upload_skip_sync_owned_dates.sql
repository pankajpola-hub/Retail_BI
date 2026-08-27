-- =============================================================================
-- 0097 · Excel sale-upload auto-skips rows for (branch, date) the nightly
--        sync already owns — fixes C-06 (docs/audit/C-database.md)
-- =============================================================================
-- Problem (proven live, see C-06): raw_logic.sales_transactions' natural key
-- is UNIQUE (branch_name, bill_date, bill_no, item_code, line_seq), and
-- line_seq is DERIVED INDEPENDENTLY by each writer —
-- parseSaleWorkbook.ts numbers repeat (branch,date,bill,item) lines in the
-- order they appear in the workbook; ops.fn_upsert_synced_sale_rows'
-- caller (api/cron/sale-detail-sync/route.ts) numbers them in sale_detail's
-- own fetch order (fin_year, vouch_code, barcode, sold_mrp, bill_type).
-- Those two orderings can disagree for the same physical bill line (the
-- ERP's sale_detail grain includes sold_mrp/bill_type, the Excel export
-- doesn't), so the same line lands as line_seq=1 from one writer and
-- line_seq=2 from the other — two different conflict keys, ON CONFLICT
-- never fires, and the line is double-counted. Live proof: bill
-- 2627/3/SB-000343, item 8905385747729, dated 23/05/2026, currently
-- costing the dashboard +1 unit / +Rs 89 network-wide. Unbounded if anyone
-- re-uploads Excel for a date range the sync has already synced (the sync
-- covers the current fiscal year onward — see 0090).
--
-- Pankaj's decision (2026-08-27): "Auto-skip overlapping Excel rows" — on
-- Excel sale upload, silently skip rows for any (branch, bill_date) that
-- already has at least one sale_detail_sync-sourced row, rather than
-- blocking the upload or asking the user to resolve it per-bill. No manual
-- action needed on every upload; no double-count possible going forward.
--
-- Granularity — (branch_name, bill_date), not exact bill-line match:
--   * Matches the decision's own wording ("dates a store already has
--     sync-sourced data for").
--   * Simpler and cheaper than reconciling individual (bill_no, item_code,
--     line_seq) triples across two independently-numbered sequences —
--     which is the exact mismatch that caused C-06 in the first place, so
--     line-level matching would just move the same fragile assumption one
--     level down instead of removing it.
--   * Partial-day sync gap risk considered and accepted: the nightly sync
--     (api/cron/sale-detail-sync) re-scans the ENTIRE current-FY window on
--     every run, not just new/changed rows (0090's header: "no incremental
--     cursor exists on sale_detail... every run re-scans the whole
--     current-FY window"). So even if one run fails partway through and
--     leaves a given date under-synced, the very next night's run
--     re-covers that same date completely — a per-date skip can only ever
--     hide Excel rows for a date that will itself be fully re-synced
--     within 24h, never a date the sync has permanently only partially
--     covered. A store/date the sync has NEVER reached (pre-go-live
--     history, or a future date the ERP hasn't posted to `sale_detail`
--     yet) has zero sync rows and is untouched by this filter — Excel
--     stays authoritative there, unchanged from today.
--   * "Replace", not just "skip": an Excel row for a sync-owned date that
--     was already committed by an EARLIER Excel upload (before the sync
--     existed, or before this migration) is left alone by this filter —
--     this migration only guards NEW inserts, it doesn't retroactively
--     delete already-committed Excel rows for sync-owned dates. That's a
--     deliberate scope limit: this migration fixes the upload path going
--     forward, not a live-data cleanup (the live +1 unit/+Rs89 drift from
--     C-06's proof case is a separate, user-run cleanup).
--
-- Where — inside ops.fn_process_sale_upload itself (not the TypeScript
-- commit route): the skip must be transactionally consistent with the
-- insert (a sync row could theoretically land between a TS-side "check"
-- and the insert otherwise), and this is a single SECURITY DEFINER
-- function anyway, so the extra EXISTS join costs nothing extra in round
-- trips. The route.ts layer only needs the RESULT — how many rows were
-- skipped for this reason — to surface to the user, so the function's
-- return type changes from a bare integer (committed-row count) to jsonb
-- {committed, skipped_sync_owned}, matching the shape convention 0088
-- already established for fn_process_master_upload (which returns
-- jsonb {inserted, updated, total}) rather than inventing a new shape.
--
-- Visibility, not a blocking dialog: per Pankaj's decision this is
-- SILENT (no confirmation prompt blocks the upload), but "silent" is
-- interpreted as "no blocking dialog," not "no visibility at all" — the
-- skipped-row count is returned in the same response the caller already
-- reads committedRows from, and the commit route surfaces it as
-- `skippedSyncOwnedRows` alongside the existing `skippedRows` (invalid-row)
-- and `committedRows` counts. See web/app/api/data-upload/process/[id]/
-- commit/route.ts's "sale" branch for the response shape change.

drop function if exists ops.fn_process_sale_upload(uuid, jsonb, boolean);

create function ops.fn_process_sale_upload(
  p_upload_id uuid,
  p_rows jsonb,
  p_mark_processed boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = core, raw_logic, ops, extensions, pg_temp
as $$
declare
  v_committed integer;
  v_skipped_sync integer;
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
      shade_name text, pack_size text, category text, subcategory text,
      season text, market_segment text, gender text, size_group text, mrp numeric,
      line_seq integer
    )
  ),
  -- Every (branch, date) that the nightly sync has already written at
  -- least one row for. Computed once per call, reused by both branches
  -- below via the CTEs that read from it.
  sync_owned_dates as (
    select distinct branch_name, bill_date
    from raw_logic.sales_transactions
    where source = 'sale_detail_sync'
  ),
  committable as (
    select p.*
    from parsed p
    where not exists (
      select 1 from sync_owned_dates so
      where so.branch_name = p.branch_name and so.bill_date = p.bill_date
    )
  ),
  ins as (
    insert into raw_logic.sales_transactions
      (branch_name, bill_date, bill_no, item_code, total_quantity, gross_amount, net_amount,
       agent_name, scheme_name, scheme_group_name, bill_time,
       shade_name, pack_size, category, subcategory, season, market_segment, gender, size_group, mrp,
       line_seq)
    select branch_name, bill_date, bill_no, item_code, total_quantity, gross_amount, net_amount,
           agent_name, scheme_name, scheme_group_name, bill_time,
           shade_name, pack_size, category, subcategory, season, market_segment, gender, size_group, mrp,
           line_seq
    from committable
    on conflict (branch_name, bill_date, bill_no, item_code, line_seq)
    do update set
      total_quantity     = excluded.total_quantity,
      gross_amount       = excluded.gross_amount,
      net_amount          = excluded.net_amount,
      agent_name           = excluded.agent_name,
      scheme_name            = excluded.scheme_name,
      scheme_group_name       = excluded.scheme_group_name,
      bill_time                = excluded.bill_time,
      shade_name                = excluded.shade_name,
      pack_size                  = excluded.pack_size,
      category                    = excluded.category,
      subcategory                  = excluded.subcategory,
      season                        = excluded.season,
      market_segment                = excluded.market_segment,
      gender                          = excluded.gender,
      size_group                      = excluded.size_group,
      mrp                               = excluded.mrp,
      _airbyte_extracted_at     = now()
    returning 1
  )
  select count(*) into v_committed from ins;

  -- Skipped-row count computed separately (not "rows in parsed minus rows
  -- in ins") because ins only counts rows that made it through the INSERT,
  -- and a row can also be absent from ins for reasons unrelated to this
  -- filter (none today — sale-upload has no other WHERE clause — but this
  -- keeps the two counters honest independently rather than by
  -- subtraction, matching how master's fn_process_master_upload keeps
  -- inserted/updated as two real counts, not a derived one).
  select count(*) into v_skipped_sync
  from parsed p
  where exists (
    select 1 from raw_logic.sales_transactions st
    where st.source = 'sale_detail_sync'
      and st.branch_name = p.branch_name
      and st.bill_date = p.bill_date
  );

  if p_mark_processed then
    update ops.erp_report_uploads set status = 'processed', notes = null where id = p_upload_id;
  end if;

  return jsonb_build_object(
    'committed', v_committed,
    'skipped_sync_owned', v_skipped_sync
  );
end;
$$;

revoke all on function ops.fn_process_sale_upload(uuid, jsonb, boolean) from public, anon;
grant execute on function ops.fn_process_sale_upload(uuid, jsonb, boolean) to authenticated;

notify pgrst, 'reload schema';
