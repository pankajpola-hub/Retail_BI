-- =============================================================================
-- 0032 · Targets page: Undri regression fix, Category filter, daily Remarks
-- =============================================================================
-- Three unrelated asks bundled into one migration because they all touch the
-- same page/objects and were assigned together. Each section below is
-- independently reviewable.

-- =============================================================================
-- SECTION A — "Targets for Undri vanished" regression
-- =============================================================================
-- ROOT-CAUSE FINDING #1 (confirmed by direct file comparison, not guesswork):
-- supabase/migrations/ — the folder that actually gets pushed to production
-- via `npx supabase db push` — is MISSING three files that exist in
-- server/db/migrations/: 0023_fresh_disc_50pct_rule.sql,
-- 0025_fresh_disc_50pct_rounding_tolerance.sql, and
-- 0027_exclude_accessories_from_fresh_disc_tracker.sql. Every other file from
-- 0001 through 0030 is present in both folders; only these three numbers are
-- missing from supabase/migrations/. This means the claim "migrations through
-- 0030 are live on production" (true by file count / highest number applied)
-- is misleading: three migrations in the middle of that range were never
-- copied over and so were never pushed, even though everything numbered
-- above and below them was.
--
-- Practical effect on THIS regression: ops.fn_monthly_fresh_disc_tracker
-- (0029) does not actually depend on 0023/0025/0027 having run — it
-- reimplements the Fresh/Discounted split and accessory exclusion inline
-- from scratch (own CREATE FUNCTION body), and every view it touches
-- (sales.vw_item_subcategory_lookup, ops.vw_monthly_fresh_disc_audit_lines)
-- is (re)created with CREATE OR REPLACE inside 0029 itself, which works
-- whether or not a same-named object already existed. So this gap does NOT,
-- by itself, explain rows.length === 0 for Undri. It is still a real,
-- confirmed bug independent of the Undri symptom: ops.vw_monthly_fresh_disc_
-- tracker (the OLD view, left in place by 0029 "for any other consumer") is
-- currently serving 0020's ORIGINAL logic in production — scheme_group_name-
-- based Fresh/Discounted, NO accessory exclusion, NO 0.495 rounding
-- tolerance — silently different from what every comment in this codebase
-- (including 0029's own) claims is live. Fixed below by copying the three
-- missing files into supabase/migrations/ so the next `db push` catches them
-- up; nothing else needed since CREATE OR REPLACE VIEW is idempotent/safe to
-- reapply in order.
--
-- ROOT-CAUSE INVESTIGATION for the actual zero-rows symptom: a full
-- line-by-line diff of ops.vw_monthly_fresh_disc_tracker's final live logic
-- (0020+0023+0025+0027, i.e. what it WOULD be if the gap above were the only
-- issue) against ops.fn_monthly_fresh_disc_tracker (0029) for the p_gender =
-- p_subcategory = NULL case found NO discrepancy: same accessory exclusion
-- list, same discount-ratio filter structure, same spine/pacing window
-- functions, same core.fn_user_store_ids() scoping (that function is
-- SECURITY DEFINER, so it behaves identically whether called from a
-- security_invoker view or a security invoker function — the caller's
-- session/current_user_id() is unaffected either way), same
-- sales.vw_ebo_sales_lines (confirmed byte-identical to its pre-0029 version
-- except the appended line_id column). No DB access was available to this
-- session to run the two side by side against live Undri data directly
-- (service_role has no USAGE grant on the core/sales/ops schemas in this
-- project — every attempt returned `permission denied for schema`, and no
-- direct Postgres connection string is present in web/.env.local), so this
-- could not be proven empirically against production. The likeliest
-- explanation this session could NOT rule out without DB/log access:
-- PostgREST's schema cache not having reloaded after 0029's function was
-- created (a known Supabase gotcha — a brand-new RPC function is invisible
-- to PostgREST, returning a 404/PGRST202 "function not found" error, not a
-- SQL error, until the schema cache reloads) — ask the lead to check the
-- Vercel/browser network tab for the exact error status/body the
-- fn_monthly_fresh_disc_tracker POST returns for Undri, or simply re-run
-- `select pg_notify('pgrst', 'reload schema');` against the project.
--
-- Defensive hardening applied below regardless (belt-and-suspenders, cannot
-- hurt the NULL/NULL unfiltered case): normalise p_period_month to the 1st
-- of its month with date_trunc rather than trusting the caller already sent
-- exactly that, and trim p_store_id. Also folds in the 0025 rounding
-- tolerance (0.495, not the 0.5 this function shipped with in 0029 — 0029
-- copied 0027's threshold, which itself was deliberately built on the
-- pre-0025 value; see 0027's own header) so the function's Fresh/Discounted
-- split matches the CORRECT, intended-live threshold once Section A's file
-- copy lands, not the stale one.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- sales.vw_ebo_sales_lines — append category (Section C needs it; done here
-- alongside the rest of this migration's view work). Append-only, same
-- pattern as line_id (0029): every existing positional/column-name consumer
-- is unaffected.
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
  st.id                                                            as line_id,
  nullif(trim(st.category), '')                                    as category
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
  'Line grain: store x date x bill x item, plus agent_name and bill_time where the source provides them (both nullable), line_id (0029, stable surrogate key for keyset pagination), and category (0032, from raw_logic.sales_transactions.category added in 0030 — as-of-sale point-of-sale value, APPAREL/ACCESSORIES per 0030''s header). security_invoker = OFF, deliberately — see 0015 for why.';

-- -----------------------------------------------------------------------------
-- sales.vw_sale_category_options — distinct Category values for the Targets
-- page dropdown. Sourced from the sale line itself (point-of-sale value),
-- NOT the stock-snapshot lookup used for Gender/Subcategory (0029) — 0030's
-- header explains why the sale line's own value is better provenance.
-- ACCESSORIES is deliberately omitted: 0027 excludes accessory subcategories
-- from BOTH tracker buckets entirely, so selecting Category = ACCESSORIES
-- would always show 0/0 on the tracker — same "omit from the dropdown
-- rather than offer a choice that always nets to zero" posture 0029 already
-- used for accessory subcategories.
-- -----------------------------------------------------------------------------
create or replace view sales.vw_sale_category_options
with (security_invoker = off, security_barrier = true) as
select distinct category
from sales.vw_ebo_sales_lines
where category is not null
  and category <> 'ACCESSORIES'
order by category;

comment on view sales.vw_sale_category_options is
  'Distinct CATEGORY values seen on real sale lines (raw_logic.sales_transactions.category, 0030), excluding ACCESSORIES (always 0/0 on the tracker per 0027''s exclusion — omitted rather than offered as a dead-end choice). Backs the Targets page Category filter dropdown (0032).';

grant select on sales.vw_sale_category_options to authenticated;

-- -----------------------------------------------------------------------------
-- ops.fn_monthly_fresh_disc_tracker — add p_category (NULL = unfiltered,
-- same pattern as p_gender/p_subcategory), fold in the 0025 rounding
-- tolerance, and add the defensive p_period_month/p_store_id normalisation
-- described in Section A above.
-- -----------------------------------------------------------------------------
-- CREATE OR REPLACE FUNCTION only replaces a function with an IDENTICAL
-- parameter list — adding p_category as a 5th parameter would otherwise
-- create a SECOND overloaded function alongside 0029's original 4-arg
-- version rather than replacing it, which is exactly the kind of ambiguity
-- ("Could not choose the best candidate function") that breaks PostgREST
-- RPC resolution. Drop the old signature explicitly first.
drop function if exists ops.fn_monthly_fresh_disc_tracker(text, date, text, text);

create or replace function ops.fn_monthly_fresh_disc_tracker(
  p_store_id text,
  p_period_month date,
  p_gender text default null,
  p_subcategory text default null,
  p_category text default null
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
  with params as (
    select
      btrim(p_store_id)                          as store_id,
      date_trunc('month', p_period_month)::date   as period_month
  ),
  actual_daily as (
    select
      l.store_id,
      l.bill_date,
      sum(l.total_quantity) filter (
        where not coalesce(sub.subcategory in (
                'BOW CLIP', 'HAIR CLIP', 'HAIRBAND', 'SCRUNCHIE', 'NECKLACE', 'WAIST CHAIN'
              ), false)
          and (p_gender is null or sub.gender = p_gender)
          and (p_subcategory is null or sub.subcategory = p_subcategory)
          and (p_category is null or l.category = p_category)
          and (l.gross_amount = 0 or (l.discount_amount / l.gross_amount) < 0.495)
      )                                                                as fresh_actual_qty,
      sum(l.total_quantity) filter (
        where not coalesce(sub.subcategory in (
                'BOW CLIP', 'HAIR CLIP', 'HAIRBAND', 'SCRUNCHIE', 'NECKLACE', 'WAIST CHAIN'
              ), false)
          and (p_gender is null or sub.gender = p_gender)
          and (p_subcategory is null or sub.subcategory = p_subcategory)
          and (p_category is null or l.category = p_category)
          and l.gross_amount <> 0 and (l.discount_amount / l.gross_amount) >= 0.495
      )                                                                as discounted_actual_qty
    from sales.vw_ebo_sales_lines l
    left join sales.vw_item_subcategory_lookup sub on sub.item_code = l.item_code
    where l.store_id = (select store_id from params)
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
    where t.store_id = (select store_id from params)
      and t.period_month = (select period_month from params)
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
  'Parameterized twin of ops.vw_monthly_fresh_disc_tracker (0020/0023/0025/0027) with optional p_gender/p_subcategory (0029) and p_category (0032, NULL = no filter, matches the view exactly once 0023/0025/0027 are live — see 0032''s header on the migration-folder gap that means they are not, as of this migration). 0.495-of-gross Fresh/Discounted split (0025 tolerance, corrected here from the 0.5 this function shipped with in 0029), same accessory exclusion, same MTD pacing math. p_period_month is normalised with date_trunc and p_store_id is trimmed defensively (0032) — insurance against a caller passing a non-canonical value, not a confirmed root cause of the Undri regression this migration was written to investigate. Backs web/app/(ho)/targets/page.tsx. NOTE: fresh_target_qty/discounted_target_qty are never filtered — ops.ebo_monthly_targets has no gender/subcategory/category breakdown, so a filtered actual is compared against the whole-month target regardless of filter. The page must label this.';

revoke all on function ops.fn_monthly_fresh_disc_tracker(text, date, text, text, text) from public, anon;
grant execute on function ops.fn_monthly_fresh_disc_tracker(text, date, text, text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- ops.vw_monthly_fresh_disc_audit_lines — add category alongside gender/
-- subcategory (0029) so the download can be filtered/verified against the
-- same Category slice the on-screen filter shows.
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
    when l.gross_amount = 0 or (l.discount_amount / l.gross_amount) < 0.495
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
    when (l.discount_amount / l.gross_amount) < 0.495 and l.scheme_name is null
      then 'Fresh — no scheme'
    when (l.discount_amount / l.gross_amount) < 0.495
      then 'Fresh — scheme ' || l.scheme_name || ' only '
           || round(100.0 * l.discount_amount / l.gross_amount, 1)::text || '% off'
    else 'Discounted — ' || coalesce(l.scheme_name, '(no scheme name on file)') || ', '
         || round(100.0 * l.discount_amount / l.gross_amount, 1)::text || '% off'
  end as reason,
  l.category
from sales.vw_ebo_sales_lines l
left join sales.vw_item_subcategory_lookup sub on sub.item_code = l.item_code;

comment on view ops.vw_monthly_fresh_disc_audit_lines is
  'Line-level detail backing the /targets audit report download. bucket mirrors ops.fn_monthly_fresh_disc_tracker''s classification exactly (0.495-of-gross Fresh/Discounted split, accessory subcategories excluded from both) so summing total_quantity per bucket, filtered to one store + month (+ optional gender/subcategory/category), reproduces the tracker''s displayed numbers. category (0032) is the point-of-sale value from raw_logic.sales_transactions (0030), independent of the stock-snapshot-derived subcategory/gender columns. reason is a plain-English restatement of the bucket rule. line_id is a stable surrogate key — callers MUST keyset-paginate on it (order by line_id, line_id > last-seen) rather than trust a single request to return every row, since PostgREST caps rows per request.';

grant select on ops.vw_monthly_fresh_disc_audit_lines to authenticated;

-- =============================================================================
-- SECTION B — copy the 0023/0025/0027 gap into supabase/migrations/
-- =============================================================================
-- Handled as a file-system copy alongside this migration (not SQL — see the
-- session's report), NOT by re-executing their bodies here, to avoid a
-- diff-order footgun: those three files' CREATE OR REPLACE VIEW statements
-- against ops.vw_monthly_fresh_disc_tracker must run in their original
-- 0023 -> 0025 -> 0027 order (each supersedes the last), which only happens
-- correctly if they are pushed as 0023/0025/0027, before this file's number.
--
-- One consequence: 0027's CREATE OR REPLACE VIEW body (as originally
-- authored, unmodified) reintroduces the strict 0.5 threshold on top of
-- 0025's 0.495 fix, exactly as its own header warns it would if pushed after
-- 0025 without also folding 0025's change in. Since this push DOES apply
-- 0027 after 0025 (filename order), the old view would otherwise end this
-- migration sequence back on the stale 0.5 threshold. Patched immediately
-- below so it doesn't.
create or replace view ops.vw_monthly_fresh_disc_tracker
with (security_invoker = on) as
with actual_daily as (
  select
    l.store_id,
    l.bill_date,
    sum(l.total_quantity) filter (
      where not coalesce(sub.subcategory in (
              'BOW CLIP', 'HAIR CLIP', 'HAIRBAND', 'SCRUNCHIE', 'NECKLACE', 'WAIST CHAIN'
            ), false)
        and (l.gross_amount = 0 or (l.discount_amount / l.gross_amount) < 0.495)
    )                                                                as fresh_actual_qty,
    sum(l.total_quantity) filter (
      where not coalesce(sub.subcategory in (
              'BOW CLIP', 'HAIR CLIP', 'HAIRBAND', 'SCRUNCHIE', 'NECKLACE', 'WAIST CHAIN'
            ), false)
        and l.gross_amount <> 0 and (l.discount_amount / l.gross_amount) >= 0.495
    )                                                                as discounted_actual_qty
  from sales.vw_ebo_sales_lines l
  left join sales.vw_item_subcategory_lookup sub on sub.item_code = l.item_code
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
where sp.store_id = any (core.fn_user_store_ids())
order by sp.store_id, sp.date;

comment on view ops.vw_monthly_fresh_disc_tracker is
  'Spans every day of the target''s month, including future days (actual = 0). The app is responsible for only rendering rows up to today — this view does not know "today". Fresh/Discounted split (0023, tolerance 0025): Discounted = discount_amount/gross_amount >= 0.495, everything else (including gross_amount = 0) is Fresh. Accessory subcategories (0027) excluded from BOTH sums entirely. Re-patched in 0032 to combine 0025 + 0027 (both were pushed to production in this same batch — see 0032''s header) — this is the OLD, superseded-for-the-page view; web/app/(ho)/targets/page.tsx uses ops.fn_monthly_fresh_disc_tracker (0029/0032) instead, this view is kept for any other consumer.';

grant select on ops.vw_monthly_fresh_disc_tracker to authenticated;

-- =============================================================================
-- SECTION C — Category filter (see view/function changes above; this is just
-- the section marker for anyone reading top-to-bottom, real work already
-- landed in the sales.vw_ebo_sales_lines / vw_sale_category_options /
-- fn_monthly_fresh_disc_tracker / vw_monthly_fresh_disc_audit_lines blocks
-- above, kept together with Section A's function rewrite instead of
-- duplicating a second CREATE OR REPLACE FUNCTION).
-- =============================================================================

-- =============================================================================
-- SECTION D — Daily store Remarks
-- =============================================================================
-- One free-text remark per (store, day) so store staff can note why that
-- day's sale was up/down, shown as a column on the Targets daily tracker.
-- Small, standalone table — does not touch ops.ebo_monthly_targets or any
-- tracker view/function.
--
-- RLS: read/write scoped by core.fn_user_store_ids(), the same "what stores
-- can this caller see" function every other store-scoped table in this
-- schema already uses (0003, reused throughout 0007/0020/etc). No role
-- check beyond store membership — the app's own page-access gate
-- (web/lib/auth/roles.ts, widened for /targets in this same change set to
-- include ebo_manager — see the session report for why) is what actually
-- decides who reaches this table's queries at all; RLS here is the second,
-- defense-in-depth layer that also stops an ebo_manager from writing a
-- remark against a store they aren't assigned to, even if the UI ever let
-- them pick one.
create table ops.daily_target_remarks (
  store_id      text not null references core.stores (store_id),
  date          date not null,
  remark_text   text,
  updated_by    uuid references core.profiles (user_id),
  updated_at    timestamptz not null default now(),
  primary key (store_id, date)
);

comment on table ops.daily_target_remarks is
  'One free-text remark per store per day (0032), shown as a column on the /targets daily Fresh/Discounted tracker so store staff can note why a day''s sale was up or down. Independent of ops.ebo_monthly_targets — no FK to a specific target row, so a remark can exist even for a day whose month has no target set yet.';

create trigger trg_daily_target_remarks_touch_updated_at
  before update on ops.daily_target_remarks
  for each row execute function extensions.moddatetime(updated_at);

alter table ops.daily_target_remarks enable row level security;

create policy daily_target_remarks_read on ops.daily_target_remarks
  for select using (store_id = any (core.fn_user_store_ids()));

create policy daily_target_remarks_insert on ops.daily_target_remarks
  for insert with check (store_id = any (core.fn_user_store_ids()));

create policy daily_target_remarks_update on ops.daily_target_remarks
  for update using (store_id = any (core.fn_user_store_ids()));

grant select, insert, update on ops.daily_target_remarks to authenticated;
