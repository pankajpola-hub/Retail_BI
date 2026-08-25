-- =============================================================================
-- 0089 · Batch ops.fn_process_sale_upload (same treatment as 0088 for master)
-- =============================================================================
-- Multi-sheet, financial-year-wise Sale workbooks (2026-08-25, user-
-- confirmed) exist specifically because a full sale history can exceed
-- Excel's ~1,048,576-rows-PER-SHEET cap — meaning the ROW COUNT a single
-- commit request might need to write is easily larger than the 93,300-row
-- master file that already proved a single non-batched request blows past
-- Vercel's 60s Hobby-plan ceiling (see 0088's header: that alone took 52.8s
-- of DB time). Sale would hit the identical wall, likely worse.
--
-- Same fix as 0088: p_mark_processed lets the caller (commit/route.ts)
-- write one slice per request and only flip the upload to 'processed' on
-- the final batch. Signature changes (adding a parameter), so the old
-- 2-arg version is dropped rather than left to linger as an unused
-- overload.

drop function if exists ops.fn_process_sale_upload(uuid, jsonb);

create function ops.fn_process_sale_upload(
  p_upload_id uuid,
  p_rows jsonb,
  p_mark_processed boolean default true
)
returns integer
language plpgsql
security definer
set search_path = core, raw_logic, ops, extensions, pg_temp
as $$
declare
  v_count integer;
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
    from parsed
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
  select count(*) into v_count from ins;

  if p_mark_processed then
    update ops.erp_report_uploads set status = 'processed', notes = null where id = p_upload_id;
  end if;

  return v_count;
end;
$$;

revoke all on function ops.fn_process_sale_upload(uuid, jsonb, boolean) from public, anon;
grant execute on function ops.fn_process_sale_upload(uuid, jsonb, boolean) to authenticated;

notify pgrst, 'reload schema';
