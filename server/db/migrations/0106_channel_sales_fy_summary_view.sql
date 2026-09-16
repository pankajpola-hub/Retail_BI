-- =============================================================================
-- 0106 · sales.vw_channel_sales_fy_summary — pre-aggregated read path for
--        /sale-summary's "All years" overview table
-- =============================================================================
-- The "All years — Channel Model / Type / Name" table (2026-09-15) reads the
-- FULL history (all financial years) on every page load, independent of the
-- page's own month-range filter. Doing that by fetching every raw row from
-- sales.vw_channel_sales_summary (43,956+ rows at last count) and aggregating
-- in Node is genuinely slow: web/lib/data/client.ts's fetchAllRows() pages
-- SEQUENTIALLY at 1000 rows/request (PostgREST's project "Max Rows" cap), so
-- a 44,000-row table means ~44 round trips to the Supabase pooler, one after
-- another, before the page can even start building the hierarchy tree.
--
-- This view does the SUM(total_quantity)/SUM(gross_amount) GROUP BY
-- (financial_year, channel_model, channel_type, channel_name) in Postgres
-- instead — the result is at most a few hundred rows (one per real
-- combination that ever had data, not one per raw transaction), fits in a
-- single PostgREST page, and Postgres aggregates its own table far faster
-- than 44 round trips plus a Node-side reduce ever could.
--
-- FINANCIAL YEAR COMPUTED IN SQL (April-March, "FY<startYear>-<endYear last
-- two digits>") — the ONLY place this rule is implemented now that the view
-- supplies financial_year directly; the app-side financialYearOf() helper
-- this mirrored is retired (fyHierarchy.ts reads financial_year straight off
-- this view's rows instead of deriving it in Node).
-- =============================================================================

create view sales.vw_channel_sales_fy_summary as
select
  case
    when extract(month from bill_month) >= 4
      then 'FY' || extract(year from bill_month)::int
           || '-' || lpad(((extract(year from bill_month)::int + 1) % 100)::text, 2, '0')
    else 'FY' || (extract(year from bill_month)::int - 1)
           || '-' || lpad((extract(year from bill_month)::int % 100)::text, 2, '0')
  end as financial_year,
  coalesce(channel_model, '(no channel model)') as channel_model,
  coalesce(channel_type, '(no channel type)') as channel_type,
  coalesce(channel_name, '(blank)') as channel_name,
  sum(total_quantity) as qty,
  sum(gross_amount) as gross
from raw_logic.channel_sales_summary
where core.fn_user_role() in ('ho_admin', 'regional_manager', 'super_admin')
group by 1, 2, 3, 4;

comment on view sales.vw_channel_sales_fy_summary is
  'Pre-aggregated (financial_year, channel_model, channel_type, channel_name) sums for /sale-summary''s "All years" overview table (0106) — avoids fetching the full raw_logic.channel_sales_summary table (tens of thousands of rows, ~44 sequential PostgREST pages at 1000/page) just to re-sum it in Node on every page load. Same role gate as sales.vw_channel_sales_summary (0101/0104), applied directly in the predicate per the C-09 lesson (migration 0097). NULL channel_model/channel_type/channel_name are coalesced to the same "(no ...)"/"(blank)" placeholders lib/saleSummary/fyHierarchy.ts already uses, so the two never disagree on how to label a blank.';

grant select on sales.vw_channel_sales_fy_summary to authenticated;

notify pgrst, 'reload schema';
