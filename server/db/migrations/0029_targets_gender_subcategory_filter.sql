-- =============================================================================
-- 0029 · Targets page: Gender / Subcategory filters + richer line-level audit
-- =============================================================================
-- Two asks, both scoped to the /targets Fresh-vs-Discounted tracker:
--
-- 1. Filter the tracker by Gender and Subcategory so every number on the page
--    (targets... see caveat below, actuals, cumulative, MTD deficit%)
--    recomputes against just the filtered subset, same idea as the existing
--    Store filter.
--
--    "Category" was asked for too, but there is no such column or concept
--    anywhere in this schema — raw_logic.stock_snapshot (0024) only carries
--    GENDER and SUBCATEGORY (37 distinct real values, see 0027's header), no
--    separate parent-category grouping. Rather than invent a fake grouping of
--    subcategories into categories (which would be guessing at merchandising
--    structure nobody confirmed), this migration implements Gender +
--    Subcategory only. Flagged again in web/app/(ho)/targets/page.tsx where
--    the filters are wired up.
--
--    CAVEAT the UI must make visible: ops.ebo_monthly_targets (0020) stores
--    ONE fresh_target_qty/discounted_target_qty per store/month — there is no
--    gender/subcategory breakdown of the *target* anywhere, because nobody
--    enters it split that way. So a Gender/Subcategory filter narrows the
--    ACTUAL side (and therefore cumulative + MTD deficit%, which are both
--    actual-vs-target) but the monthly target number itself stays the whole-
--    month figure regardless of filter. Achievement% against a whole-month
--    target while looking at a Gender/Subcategory slice of actuals is
--    consequently not "the store's real pace on this slice" — it's a smaller
--    numerator over the same denominator. Real, not fabricated, but the page
--    must label it so nobody reads it as a sub-target.
--
-- 2. Extend the line-level audit download (0027's
--    ops.vw_monthly_fresh_disc_audit_lines) with the fields actually needed
--    to verify a line's classification by eye — scheme_name, discount_pct
--    was already there, but not a plain-English reason — plus gender, so the
--    download can be filtered/verified against the same slice the on-screen
--    filters show.
--
-- Also fixes a real correctness bug the new filters would otherwise inherit:
-- neither backend (Supabase PostgREST, max_rows = 1000 per supabase/
-- config.toml; the self-hosted PostgREST is presumably configured similarly)
-- returns more than ~1000 rows from a single REST request, and this app's
-- DataClient wrapper (web/lib/data/client.ts) has no .range()/offset method
-- to page around that. A single store-month of line-level sales easily
-- exceeds 1000 rows (0024's header: ~21000 real rows total across just two
-- stores over the sample period) — so the EXISTING /targets audit-report
-- download has likely been silently truncating to the first ~1000 lines in
-- production already, before this migration touches anything. Fixed here by
-- moving the actual Fresh/Discounted computation for the tracker into a
-- SECURITY INVOKER SQL function that does the aggregation and MTD pacing
-- window functions IN THE DATABASE (returns ~31 rows, one per day of the
-- month, never more) instead of pulling every line to the Next.js server and
-- summing there. The line-level audit download still returns many rows by
-- design (that's the point of a line-level download) — that route is
-- separately updated to page through with .gt() keyset pagination on the new
-- line_id column added below, so it no longer silently drops rows past 1000.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Surrogate key for raw_logic.sales_transactions — didn't have one. 0024 added
-- a natural-key UNIQUE constraint (branch_name, bill_date, bill_no, item_code,
-- line_seq) but no single monotonically-orderable column, which keyset
-- pagination through PostgREST's row cap needs. Backfills automatically for
-- existing rows (full table rewrite, ~21k rows — fine at this size).
-- -----------------------------------------------------------------------------
alter table raw_logic.sales_transactions
  add column if not exists id bigint generated always as identity;

-- -----------------------------------------------------------------------------
-- sales.vw_ebo_sales_lines: expose the new id as line_id, appended at the end
-- so every existing positional/column-name consumer is unaffected.
-- -----------------------------------------------------------------------------
create or replace view sales.vw_ebo_sales_lines
with (security_invoker = off, security_barrier = true) as
select
  s.store_id,
  parsed.branch_date                                              as bill_date,
  st.bill_no,
  case
    when left(st.bill_no, 2) = 'SB' then 'SALE'
    when left(st.bill_no, 2) = 'RB' then 'RETURN'
    else 'OTHER'
  end                                                              as bill_type,
  st.item_code,
  st.total_quantity,
  st.gross_amount,
  coalesce(st.net_amount, st.gross_amount)                        as net_amount,
  (st.gross_amount - coalesce(st.net_amount, st.gross_amount))     as discount_amount,
  nullif(trim(st.scheme_name), '')                                 as scheme_name,
  nullif(trim(st.scheme_group_name), '')                           as scheme_group_name,
  nullif(trim(st.agent_name), '')                                  as agent_name,
  parsed.bill_time_parsed                                          as bill_time,
  st.id                                                            as line_id
from raw_logic.sales_transactions st
  cross join lateral (
    select
      case
        when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$'
          then to_date(st.bill_date, 'DD/MM/YYYY')
        else st.bill_date::date
      end as branch_date,
      case
        when st.bill_time ~ '^\d{2}:\d{2}:\d{2} (AM|PM)$'
          then to_timestamp(st.bill_time, 'HH12:MI:SS AM')::time
        else null
      end as bill_time_parsed
  ) parsed
  join core.stores s on s.branch_name_erp = st.branch_name and s.is_active
where st.branch_name is not null
  and st.bill_no not in ('BRANCH WISE TOTALS', 'GRAND TOTALS')
  and s.store_id = any (core.fn_user_store_ids());

comment on view sales.vw_ebo_sales_lines is
  'Line grain: store x date x bill x item, plus agent_name and bill_time where the source provides them (both nullable), and line_id (0029) — a stable, monotonically increasing surrogate key for keyset pagination past PostgREST''s per-request row cap. security_invoker = OFF, deliberately — see 0015 for why.';

-- -----------------------------------------------------------------------------
-- sales.vw_item_subcategory_lookup: add gender alongside subcategory. Same
-- item_code -> attributes resolution as 0027 (most-recently-loaded stock
-- snapshot row wins per item_code), same NULL-means-"not confirmed" posture.
-- -----------------------------------------------------------------------------
create or replace view sales.vw_item_subcategory_lookup
with (security_invoker = off, security_barrier = true) as
select item_code, subcategory, gender
from (
  select
    ss.item_code,
    nullif(trim(ss.subcategory), '') as subcategory,
    nullif(trim(ss.gender), '')      as gender,
    row_number() over (
      partition by ss.item_code
      order by ss.loaded_at desc, ss.id desc
    ) as rn
  from raw_logic.stock_snapshot ss
  where ss.item_code is not null and trim(ss.item_code) <> ''
) x
where rn = 1;

comment on view sales.vw_item_subcategory_lookup is
  'One row per item_code, subcategory + gender (0029) from the CURRENT stock snapshot (full-replace per upload, see 0024). If a future snapshot ever has one item_code map to >1 value, the most-recently-loaded row wins deterministically. A sales line whose item_code is absent from the current snapshot finds no match and gets NULLs here — every consumer treats NULL/no-match as "not confirmed", never asserted either way.';

grant select on sales.vw_item_subcategory_lookup to authenticated;

-- -----------------------------------------------------------------------------
-- Distinct-value option lists for the Gender / Subcategory filter dropdowns.
-- Tiny (a handful of genders, ~37 subcategories per 0027), so no row-cap risk.
-- Subcategory options exclude the 6 accessory values (0027) — selecting one
-- would always show 0/0 on this tracker since accessories are dropped from
-- both buckets entirely, so surfacing them as choices here would be
-- misleading rather than useful.
-- -----------------------------------------------------------------------------
create or replace view sales.vw_item_gender_options
with (security_invoker = off, security_barrier = true) as
select distinct gender
from sales.vw_item_subcategory_lookup
where gender is not null
order by gender;

comment on view sales.vw_item_gender_options is
  'Distinct GENDER values seen in the current stock snapshot. Backs the Targets page Gender filter dropdown (0029).';

grant select on sales.vw_item_gender_options to authenticated;

create or replace view sales.vw_item_subcategory_options
with (security_invoker = off, security_barrier = true) as
select distinct subcategory
from sales.vw_item_subcategory_lookup
where subcategory is not null
  and subcategory not in ('BOW CLIP', 'HAIR CLIP', 'HAIRBAND', 'SCRUNCHIE', 'NECKLACE', 'WAIST CHAIN')
order by subcategory;

comment on view sales.vw_item_subcategory_options is
  'Distinct non-accessory SUBCATEGORY values seen in the current stock snapshot. Backs the Targets page Subcategory filter dropdown (0029) — accessory subcategories (see 0027) are omitted because they always net to 0/0 on this tracker.';

grant select on sales.vw_item_subcategory_options to authenticated;

-- -----------------------------------------------------------------------------
-- ops.fn_monthly_fresh_disc_tracker — parameterized replacement for querying
-- ops.vw_monthly_fresh_disc_tracker directly from the page, adding optional
-- p_gender / p_subcategory (NULL = no filter, i.e. identical output to the
-- unfiltered view for the same store/month). SECURITY INVOKER: it only reads
-- views/tables the caller already has grants + RLS for (sales.vw_ebo_sales_lines
-- filters by core.fn_user_store_ids() internally; ops.ebo_monthly_targets carries
-- its own RLS policy), same posture as the view it replaces. Returns one row
-- per day of the month (~28-31 rows) regardless of how many underlying sales
-- lines exist, so this never runs into the ~1000-row PostgREST cap the way a
-- raw line-level select would.
--
-- The view (ops.vw_monthly_fresh_disc_tracker) is left in place unchanged for
-- any other consumer; this function reimplements the identical logic rather
-- than wrapping the view, because the view has no parameters to filter on.
-- -----------------------------------------------------------------------------
create or replace function ops.fn_monthly_fresh_disc_tracker(
  p_store_id text,
  p_period_month date,
  p_gender text default null,
  p_subcategory text default null
)
returns table (
  target_id               uuid,
  store_id                text,
  period_month             date,
  date                      date,
  day_name                  text,
  day_of_month               int,
  days_in_month               int,
  fresh_target_qty             integer,
  discounted_target_qty         integer,
  fresh_actual_qty                numeric,
  discounted_actual_qty            numeric,
  fresh_cum_qty                     numeric,
  discounted_cum_qty                 numeric,
  fresh_mtd_target                    numeric,
  discounted_mtd_target                numeric
)
language sql
security invoker
set search_path = core, sales, ops, extensions, pg_temp
as $$
  with actual_daily as (
    select
      l.store_id,
      l.bill_date,
      sum(l.total_quantity) filter (
        where not coalesce(sub.subcategory in (
                'BOW CLIP', 'HAIR CLIP', 'HAIRBAND', 'SCRUNCHIE', 'NECKLACE', 'WAIST CHAIN'
              ), false)
          and (p_gender is null or sub.gender = p_gender)
          and (p_subcategory is null or sub.subcategory = p_subcategory)
          and (l.gross_amount = 0 or (l.discount_amount / l.gross_amount) < 0.5)
      )                                                                as fresh_actual_qty,
      sum(l.total_quantity) filter (
        where not coalesce(sub.subcategory in (
                'BOW CLIP', 'HAIR CLIP', 'HAIRBAND', 'SCRUNCHIE', 'NECKLACE', 'WAIST CHAIN'
              ), false)
          and (p_gender is null or sub.gender = p_gender)
          and (p_subcategory is null or sub.subcategory = p_subcategory)
          and l.gross_amount <> 0 and (l.discount_amount / l.gross_amount) >= 0.5
      )                                                                as discounted_actual_qty
    from sales.vw_ebo_sales_lines l
    left join sales.vw_item_subcategory_lookup sub on sub.item_code = l.item_code
    where l.store_id = p_store_id
    group by l.store_id, l.bill_date
  ),
  spine as (
    select
      t.id                    as target_id,
      t.store_id,
      t.period_month,
      t.fresh_target_qty,
      t.discounted_target_qty,
      d::date                 as date,
      (extract(day from ((t.period_month + interval '1 month' - interval '1 day')))::int) as days_in_month
    from ops.ebo_monthly_targets t
    cross join lateral generate_series(
      t.period_month,
      (t.period_month + interval '1 month' - interval '1 day')::date,
      interval '1 day'
    ) d
    where t.store_id = p_store_id
      and t.period_month = p_period_month
      and t.store_id = any (core.fn_user_store_ids())
  )
  select
    sp.target_id,
    sp.store_id,
    sp.period_month,
    sp.date,
    to_char(sp.date, 'Dy')                                    as day_name,
    extract(day from sp.date)::int                            as day_of_month,
    sp.days_in_month,
    sp.fresh_target_qty,
    sp.discounted_target_qty,
    coalesce(a.fresh_actual_qty, 0)                           as fresh_actual_qty,
    coalesce(a.discounted_actual_qty, 0)                      as discounted_actual_qty,
    sum(coalesce(a.fresh_actual_qty, 0))
      over (partition by sp.target_id order by sp.date)       as fresh_cum_qty,
    sum(coalesce(a.discounted_actual_qty, 0))
      over (partition by sp.target_id order by sp.date)       as discounted_cum_qty,
    round(sp.fresh_target_qty::numeric * extract(day from sp.date) / sp.days_in_month, 1)
                                                                as fresh_mtd_target,
    round(sp.discounted_target_qty::numeric * extract(day from sp.date) / sp.days_in_month, 1)
                                                                as discounted_mtd_target
  from spine sp
  left join actual_daily a on a.store_id = sp.store_id and a.bill_date = sp.date
  order by sp.date;
$$;

comment on function ops.fn_monthly_fresh_disc_tracker is
  'Parameterized twin of ops.vw_monthly_fresh_disc_tracker (0020/0023/0027) with optional p_gender/p_subcategory (0029, NULL = no filter, matches the view exactly). Same 0.5-of-gross Fresh/Discounted split, same accessory exclusion, same MTD pacing math. Backs web/app/(ho)/targets/page.tsx. NOTE: fresh_target_qty/discounted_target_qty are never filtered — ops.ebo_monthly_targets has no gender/subcategory breakdown, so a filtered actual is compared against the whole-month target regardless of filter. The page must label this.';

revoke all on function ops.fn_monthly_fresh_disc_tracker from public, anon;
grant execute on function ops.fn_monthly_fresh_disc_tracker to authenticated;

-- -----------------------------------------------------------------------------
-- ops.vw_monthly_fresh_disc_audit_lines: add line_id (pagination), gender,
-- scheme_name/scheme_group_name, and a plain-English `reason` column so the
-- download answers "why" a line landed where it did without the reviewer
-- having to re-derive the threshold math by hand.
-- -----------------------------------------------------------------------------
create or replace view ops.vw_monthly_fresh_disc_audit_lines
with (security_invoker = on) as
select
  l.line_id,
  l.store_id,
  l.bill_date,
  l.bill_no,
  l.bill_type,
  l.item_code,
  sub.subcategory,
  sub.gender,
  l.total_quantity,
  l.gross_amount,
  l.net_amount,
  l.discount_amount,
  l.scheme_name,
  l.scheme_group_name,
  round(100.0 * l.discount_amount / nullif(l.gross_amount, 0), 2) as discount_pct,
  case
    when coalesce(sub.subcategory in (
           'BOW CLIP', 'HAIR CLIP', 'HAIRBAND', 'SCRUNCHIE', 'NECKLACE', 'WAIST CHAIN'
         ), false)
      then 'Excluded - Accessory'
    when l.gross_amount = 0 or (l.discount_amount / l.gross_amount) < 0.5
      then 'Fresh'
    else 'Discounted'
  end as bucket,
  case
    when coalesce(sub.subcategory in (
           'BOW CLIP', 'HAIR CLIP', 'HAIRBAND', 'SCRUNCHIE', 'NECKLACE', 'WAIST CHAIN'
         ), false)
      then 'Excluded — accessory subcategory (' || coalesce(sub.subcategory, '') || '), not counted in either bucket'
    when l.gross_amount = 0
      then 'Fresh — zero gross amount, treated as 0% discount'
    when (l.discount_amount / l.gross_amount) < 0.5 and l.scheme_name is null
      then 'Fresh — no scheme'
    when (l.discount_amount / l.gross_amount) < 0.5
      then 'Fresh — scheme ' || l.scheme_name || ' only '
           || round(100.0 * l.discount_amount / l.gross_amount, 1)::text || '% off'
    else 'Discounted — ' || coalesce(l.scheme_name, '(no scheme name on file)') || ', '
         || round(100.0 * l.discount_amount / l.gross_amount, 1)::text || '% off'
  end as reason
from sales.vw_ebo_sales_lines l
left join sales.vw_item_subcategory_lookup sub on sub.item_code = l.item_code;

comment on view ops.vw_monthly_fresh_disc_audit_lines is
  'Line-level detail backing the /targets audit report download. bucket mirrors ops.fn_monthly_fresh_disc_tracker''s classification exactly (0.5-of-gross Fresh/Discounted split, accessory subcategories excluded from both) so summing total_quantity per bucket, filtered to one store + month (+ optional gender/subcategory), reproduces the tracker''s displayed numbers. reason (0029) is a plain-English restatement of the same rule, for a reviewer who does not want to re-derive the threshold math. line_id (0029) is a stable surrogate key — callers MUST keyset-paginate on it (order by line_id, line_id > last-seen) rather than trust a single request to return every row, since PostgREST caps rows per request.';

grant select on ops.vw_monthly_fresh_disc_audit_lines to authenticated;
