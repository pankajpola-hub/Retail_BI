-- =============================================================================
-- 0004 · Base cleaned view over the Airbyte-synced Logic ERP feed
-- =============================================================================
-- ██ UNVERIFIED — Airbyte is not connected yet (confirmed 2026-08-08). ██
-- Everything below raw_logic.sales_transactions is a PLACEHOLDER guessed from
-- the sample report's column headers, not from a real synced table. Do not
-- treat this file as done until someone has:
--   1. Set up the Airbyte connector against the Logic SQL view.
--   2. Opened the actual destination table in Supabase and compared its real
--      name and column names/types against the block below.
--   3. Rewritten this file to match — most likely just renaming columns and
--      possibly deleting the text/date CASE branch under "join core.stores"
--      below if bill_date lands as a native date type (see the inline NOTE).
-- Nothing downstream (sales.*, ops.*) needs to change when this file is
-- corrected — every other view builds on sales.vw_ebo_sales_lines defined
-- here, never on raw_logic directly. This is the ONE file to revisit.
--
--   raw_logic.sales_transactions (   -- ← guessed name, verify against Airbyte
--     branch_name         text,
--     bill_date           text | date,   -- report exports it as 'DD/MM/YYYY' text; a live DB view usually gives a real date
--     bill_no              text,
--     item_code             text,
--     total_quantity        numeric,
--     gross_amount           numeric,
--     net_amount              numeric,
--     scheme_name              text,
--     scheme_group_name        text,
--     _airbyte_extracted_at    timestamptz
--   )
--
-- Three load-time defects discovered against the sample extract, all handled here:
--   1. The report embeds its own subtotal rows ('BRANCH WISE TOTALS', 'GRAND
--      TOTALS') and a merged title row. Excluded by bill_no filter + NOT NULL checks.
--   2. Two non-EBO channels (WAREHOUSE-*, OFFICE-*) ship through the same view
--      at ~230x the volume of the two real stores. Excluded by joining only
--      to onboarded core.stores rows.
--   3. Blank scheme is a single space (' '), not NULL. Normalized with NULLIF(TRIM(...), '').

-- ██ TEMPORARY STUB — DELETE THIS BLOCK once Airbyte actually lands the real
-- table. ██ Without it sales.vw_ebo_sales_lines below has nothing to compile
-- against and every migration after this one is blocked. This creates an
-- EMPTY table matching the guessed shape so the rest of the schema
-- (0005-0011) can deploy and be reviewed now. When Airbyte is connected:
-- check whether it creates raw_logic.sales_transactions itself (likely under
-- a different name, e.g. prefixed with the source stream name) — if so,
-- DROP this stub and repoint the view at the real table/columns per the
-- ASSUMPTION note above, rather than assuming Airbyte will just write into
-- this stub.
create table if not exists raw_logic.sales_transactions (
  branch_name         text,
  bill_date            text,
  bill_no               text,
  item_code              text,
  total_quantity          numeric,
  gross_amount             numeric,
  net_amount                numeric,
  scheme_name                text,
  scheme_group_name           text,
  _airbyte_extracted_at        timestamptz default now()
);

create or replace view sales.vw_ebo_sales_lines
with (security_invoker = on) as
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
  st.net_amount,
  (st.gross_amount - st.net_amount)                                as discount_amount,
  nullif(trim(st.scheme_name), '')                                 as scheme_name,
  nullif(trim(st.scheme_group_name), '')                           as scheme_group_name
from raw_logic.sales_transactions st
  -- NOTE: this branch assumes bill_date syncs as text. If the Airbyte connector
  -- lands it as a native `date` column instead, this whole lateral collapses to
  -- `st.bill_date as branch_date` — the regex match below will not compile
  -- against a date-typed column, so this is a required edit, not optional.
  cross join lateral (
    select case
      when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$'
        then to_date(st.bill_date, 'DD/MM/YYYY')
      else st.bill_date::date
    end as branch_date
  ) parsed
  join core.stores s on s.branch_name_erp = st.branch_name and s.is_active
where st.branch_name is not null
  and st.bill_no not in ('BRANCH WISE TOTALS', 'GRAND TOTALS');

comment on view sales.vw_ebo_sales_lines is
  'Line grain: store x date x bill x item. The single choke point every other sales.* view builds on — fix a data-quality issue here once, not in six places.';

-- security_invoker requires Postgres 15+ (Supabase default). It makes this view
-- run with the caller''s privileges instead of the view owner''s, so RLS on any
-- table it touches is respected. raw_logic has no end-user grants at all, so in
-- practice this view is only reachable through server-side code using the
-- service role, or through the store-filtered views in 0005 below.
revoke all on sales.vw_ebo_sales_lines from anon, authenticated;
