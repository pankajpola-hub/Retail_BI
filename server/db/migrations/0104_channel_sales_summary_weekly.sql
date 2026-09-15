-- =============================================================================
-- 0104 · Sale Summary moves from MONTH grain to WEEK grain, full data reset
-- =============================================================================
-- Pankaj supplied a consolidated historical + ongoing export, "Merged Sale
-- data from 21-26 (Till Aug).xlsx" — week grain (branch_name_OG,
-- branch_name, bill_week, week_dates, bill_month, party_name, channel_name,
-- channel_type, channel_model, total_quantity, gross_amount, net_amount),
-- April 2021 through the week of 31 Aug - 6 Sep 2026, replacing the
-- month-only pre-aggregated upload 0101 introduced. Confirmed with Pankaj:
-- wipe all existing raw_logic.channel_sales_summary data and load only this
-- file; the SAME /data-upload "Sale Summary" card is reused for every
-- future month's data too (September 2026 onward), now in this week-grain
-- shape — there is no month-grain fallback kept.
--
-- NATURAL KEY WIDENS to (branch_name, bill_month, bill_week, party_name,
-- channel_name, channel_model). channel_model joins the key because the
-- week-grain file legitimately carries both a Sale row and a Return row for
-- the same party/channel/week — the old 4-column key (no channel_model)
-- would have collided those. bill_week joins because the grain itself
-- changed from month to week.
--
-- week_start/week_end are REAL derived dates, not left as the raw "30-05"
-- label — computed by the application layer (see
-- web/lib/erpReports/parseChannelSummaryWorkbook.ts) from week_dates +
-- bill_month: when the week's start-day number is greater than its
-- end-day number, the week crosses a month boundary (start day belongs to
-- the month BEFORE bill_month, end day belongs to bill_month itself);
-- otherwise both days fall inside bill_month. Verified against this file's
-- own two real boundary cases (30 Mar - 5 Apr 2026, 31 Aug - 6 Sep 2026).
-- Stored rather than derived per-query so the page's Week/Year filters can
-- sort and range-query on real dates.
--
-- branch_name_og (the raw pre-outlet-code source tag, e.g. "PCPL" before
-- the branch-rename) is kept as a plain traceability column, never part of
-- the key or any filter/group-by — branch_name (the resolved, current name)
-- is canonical.
--
-- TRUNCATE is deliberate and explicit (Pankaj's own instruction, not an
-- oversight) — done before the ADD COLUMN ... NOT NULL statements so the
-- new columns need no backfill on rows about to be discarded anyway.
-- =============================================================================

truncate table raw_logic.channel_sales_summary;

alter table raw_logic.channel_sales_summary
  add column branch_name_og text,
  add column bill_week      smallint not null,
  add column week_dates     text not null,
  add column week_start     date not null,
  add column week_end       date not null;

alter table raw_logic.channel_sales_summary
  drop constraint channel_sales_summary_natural_key;

alter table raw_logic.channel_sales_summary
  add constraint channel_sales_summary_natural_key
    unique (branch_name, bill_month, bill_week, party_name, channel_name, channel_model);

create index channel_sales_summary_week_start_idx on raw_logic.channel_sales_summary (week_start);

comment on table raw_logic.channel_sales_summary is
  'Weekly pre-aggregated wholesale/distribution-channel sales (agents, distributors, LFS, MBO, ecomm marketplaces) — a different business view from the EBO-retail tables. One row per (branch, month, week, party, channel, channel_model), upsert-on-reupload via ops.fn_process_channel_summary_upload. Week grain since 0104 (was month-only from 0101) — bill_month/bill_week/week_dates/week_start/week_end together identify one real 7-day (or partial, at either end of the source file''s range) window. See 0101''s header for the net>gross data note (unchanged).';
comment on column raw_logic.channel_sales_summary.branch_name_og is
  'Raw pre-outlet-code source branch tag (e.g. "PCPL" before the branch-rename to codes like BO-001). Traceability only — never part of the key, never used for filtering/grouping. branch_name is canonical.';
comment on column raw_logic.channel_sales_summary.bill_week is
  'Week number as given by the source file ("Week 14" -> 14). Resets each financial year (Week 1 = first week of April) — only unique when paired with bill_month, which is why bill_month stays in the natural key alongside it.';
comment on column raw_logic.channel_sales_summary.week_dates is
  'Raw "startDay-endDay" label as given by the source file (e.g. "30-05"), kept verbatim for display/audit. week_start/week_end are the derived real dates to actually query against.';
comment on column raw_logic.channel_sales_summary.week_start is
  'Derived real start date of this week — see migration 0104 header for the month-boundary-crossing derivation rule.';
comment on column raw_logic.channel_sales_summary.week_end is
  'Derived real end date of this week — see migration 0104 header for the month-boundary-crossing derivation rule.';

-- -----------------------------------------------------------------------------
-- ops.fn_process_channel_summary_upload — widened to the week-grain shape
-- -----------------------------------------------------------------------------
create or replace function ops.fn_process_channel_summary_upload(
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
      branch_name text, branch_name_og text, bill_month date, bill_week smallint,
      week_dates text, week_start date, week_end date,
      party_name text, channel_name text, channel_type text, channel_model text,
      total_quantity numeric, gross_amount numeric, net_amount numeric
    )
  ),
  upserted as (
    insert into raw_logic.channel_sales_summary
      (branch_name, branch_name_og, bill_month, bill_week, week_dates, week_start, week_end,
       party_name, channel_name, channel_type, channel_model,
       total_quantity, gross_amount, net_amount, upload_id, source_file, updated_at)
    select branch_name, branch_name_og, bill_month, bill_week, week_dates, week_start, week_end,
           party_name, channel_name, channel_type, channel_model,
           total_quantity, gross_amount, net_amount, p_upload_id, p_source_file, now()
    from parsed
    on conflict (branch_name, bill_month, bill_week, party_name, channel_name, channel_model) do update set
      branch_name_og  = excluded.branch_name_og,
      week_dates      = excluded.week_dates,
      week_start      = excluded.week_start,
      week_end        = excluded.week_end,
      channel_type    = excluded.channel_type,
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

comment on function ops.fn_process_channel_summary_upload is
  'Batched upsert into raw_logic.channel_sales_summary, week grain since 0104. Conflict key: (branch_name, bill_month, bill_week, party_name, channel_name, channel_model). Assumes the CALLER (web/lib/erpReports/parseChannelSummaryWorkbook.ts) has already pre-aggregated (summed) any rows sharing the same key within one source file before calling this function — a fiscal-year-boundary week (e.g. 30 Mar - 5 Apr) can legitimately appear as two source rows under the same (month, week) label, one per side of the boundary, and those are genuinely additive, not a stale-vs-corrected pair. This function itself does plain overwrite-on-conflict (not additive), which keeps a later re-upload of the same month idempotent rather than double-counting.';

revoke all on function ops.fn_process_channel_summary_upload(uuid, jsonb, text, boolean) from public, anon;
grant execute on function ops.fn_process_channel_summary_upload(uuid, jsonb, text, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- sales.vw_channel_sales_summary — widened to the new columns
-- -----------------------------------------------------------------------------
create or replace view sales.vw_channel_sales_summary as
select
  id, branch_name, branch_name_og, bill_month, bill_week, week_dates, week_start, week_end,
  party_name, channel_name, channel_type, channel_model,
  total_quantity, gross_amount, net_amount, created_at, updated_at
from raw_logic.channel_sales_summary
where core.fn_user_role() in ('ho_admin', 'regional_manager', 'super_admin');

comment on view sales.vw_channel_sales_summary is
  'Read path for /sale-summary (HQ-only wholesale/distribution-channel view). Week grain since 0104. Role-gated directly (core.fn_user_role() in ho_admin/regional_manager/super_admin) rather than relying on the route layer alone — see C-09 (migration 0097). security_invoker left at its default OFF — see raw_logic.channel_sales_summary''s own comment.';

notify pgrst, 'reload schema';
