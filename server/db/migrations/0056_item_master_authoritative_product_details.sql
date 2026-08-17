-- =============================================================================
-- 0056 · raw_logic.item_master becomes the authoritative product-detail
-- source, joined by barcode (item_code), everywhere the app reads it
-- =============================================================================
-- Per the user's explicit direction (2026-08-15): "take all item related
-- details from item master only... use barcode for every lookup... barcode
-- level lookup is a must at every process." MRP and sale value/rate are
-- EXPLICITLY excluded — those stay transactional (sale line / stock
-- snapshot), never item_master.
--
-- item_master (0054) is keyed on item_code = barcode, one row per barcode
-- (item+color+size each get their own barcode — confirmed `item_code text
-- primary key`, so a join can never fan out rows). It was landed by 0054
-- but deliberately wired into nothing.
--
-- WHAT ACTUALLY NEEDED TO CHANGE, per a full consumer trace (not what was
-- initially assumed): gender/subcategory/item_name/shade/season/market_segment/
-- size_group do NOT come from the sale report today — they come from
-- sales.vw_item_subcategory_lookup and sales.vw_stock_with_scheme, both
-- sourced from raw_logic.stock_snapshot (the Stock report), not
-- raw_logic.sales_transactions. Only `category` is read directly off the
-- sale line (sales.vw_ebo_sales_lines). So three view choke-points cover
-- every downstream consumer (Targets, Stock Details, Replenishment, Network
-- filters all read through one of these three) — no other object reads
-- these columns from raw_logic directly, confirmed by grep.
--
-- COVERAGE, measured against real loaded data before writing this:
--   sales_transactions: 10,214 distinct item_codes, only 2 unmatched in
--     item_master (99.98%).
--   stock_snapshot: 22,105 distinct item_codes, 0 unmatched (100%).
--   Where both stock_snapshot and item_master have a value for the same
--     barcode, gender/subcategory agree EXACTLY; item_name "differs" only
--     because item_master's name includes the shade suffix
--     (31MFIALEG1-14599 BLCK) while stock_snapshot's is the coarser
--     style-level name (31MFIALEG1-14599) — item_master is the correct,
--     more precise barcode-grain source, not a conflicting one.
--
-- FALLBACK DESIGN: LEFT JOIN item_master primary; when a barcode isn't in
-- item_master yet, fall back to the existing source's own value rather than
-- going NULL. With today's data this is indistinguishable from "item_master
-- only" (2 rows out of 23,410 sale lines, 0 stock rows) — it exists so a
-- future upload with a not-yet-mastered barcode degrades gracefully instead
-- of silently blanking a field, consistent with this codebase's existing
-- "NULL/no-match means not confirmed, never asserted either way" convention
-- (0029's own view comment).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) sales.vw_ebo_sales_lines — category from item_master, barcode join.
--    Every other column (amounts, dates, bill_type, agent_name, scheme
--    fields) is correctly transactional and stays off the sale line,
--    untouched. Live definition is 0036's — preserved verbatim except the
--    category column and the added item_master join.
-- -----------------------------------------------------------------------------
create or replace view sales.vw_ebo_sales_lines
as
select
  s.store_id,
  parsed.branch_date                                              as bill_date,
  st.bill_no,
  case
    when st.bill_no like '%SB-%' then 'SALE'
    when st.bill_no like '%RB-%' then 'RETURN'
    else 'OTHER'
  end                                                              as bill_type,
  st.item_code,
  st.total_quantity,
  st.gross_amount,
  coalesce(st.net_amount, st.gross_amount)                        as net_amount,
  st.gross_amount - coalesce(st.net_amount, st.gross_amount)       as discount_amount,
  nullif(trim(st.scheme_name), '')                                 as scheme_name,
  nullif(trim(st.scheme_group_name), '')                           as scheme_group_name,
  nullif(trim(st.agent_name), '')                                  as agent_name,
  parsed.bill_time_parsed                                          as bill_time,
  st.id                                                            as line_id,
  coalesce(nullif(trim(im.category), ''), nullif(trim(st.category), '')) as category
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
        else null::time
      end as bill_time_parsed
  ) parsed
  join core.stores s on s.branch_name_erp = st.branch_name and s.is_active
  left join raw_logic.item_master im on im.item_code = st.item_code
where st.branch_name is not null
  and st.bill_no not in ('BRANCH WISE TOTALS', 'GRAND TOTALS')
  and s.store_id = any (core.fn_user_store_ids());

comment on view sales.vw_ebo_sales_lines is
  'Line grain: store x date x bill x item, plus agent_name and bill_time where the source provides them (both nullable), and line_id (0029) — a stable, monotonically increasing surrogate key for keyset pagination past PostgREST''s per-request row cap. security_invoker = OFF, deliberately — see 0015 for why. category (0056) is sourced from raw_logic.item_master by barcode (item_code) join, falling back to the sale line''s own category for any barcode not yet in item_master (2 of 23,410 rows as of 2026-08-15).';

-- -----------------------------------------------------------------------------
-- 2) sales.vw_item_subcategory_lookup — gender/subcategory from item_master,
--    barcode join. item_master is already 1 row per item_code (primary key),
--    so no "most recent wins" ranking is needed for it; the stock_snapshot
--    ranking (latest upload wins) is preserved as the fallback path only.
--    Name/shape/grant unchanged — every existing caller (the Fresh/Disc
--    tracker function, the audit-lines view, the gender/subcategory filter-
--    option views) is unaffected by the repointing.
-- -----------------------------------------------------------------------------
create or replace view sales.vw_item_subcategory_lookup
with (security_invoker = off, security_barrier = true) as
select
  x.item_code,
  coalesce(im.subcategory, x.subcategory) as subcategory,
  coalesce(im.gender, x.gender)           as gender
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
left join raw_logic.item_master im on im.item_code = x.item_code
where x.rn = 1;

comment on view sales.vw_item_subcategory_lookup is
  'One row per item_code. subcategory/gender (0056) are sourced from raw_logic.item_master by barcode join, falling back to the current stock snapshot''s own value (most-recently-loaded row wins, 0029/0027) for any barcode not yet in item_master. A sales line whose item_code is absent from both sources finds no match and gets NULLs here — every consumer treats NULL/no-match as "not confirmed", never asserted either way.';

grant select on sales.vw_item_subcategory_lookup to authenticated;

-- -----------------------------------------------------------------------------
-- 3) sales.vw_stock_with_scheme — item_name/shade_name/season/market_segment/
--    size_group/gender/subcategory from item_master, barcode join. Physical-
--    count and scheme fields (branch_name, godown_name, company_name, size,
--    closing_stock, rate, scheme_name, discount_pct, is_eoss) are correctly
--    transactional/point-in-time and stay off stock_snapshot/scheme_lookup,
--    untouched — this migration never reads item_master.mrp anywhere.
-- -----------------------------------------------------------------------------
create or replace view sales.vw_stock_with_scheme
with (security_invoker = off, security_barrier = true) as
select
  ss.id, ss.branch_name, ss.godown_name, ss.company_name,
  coalesce(nullif(trim(im.season), ''), ss.season)                       as season,
  coalesce(nullif(trim(im.market_segment), ''), ss.market_segment)       as market_segment,
  coalesce(nullif(trim(im.gender), ''), nullif(trim(ss.gender), ''))     as gender,
  coalesce(nullif(trim(im.size_group), ''), nullif(trim(ss.size_group), '')) as size_group,
  coalesce(nullif(trim(im.subcategory), ''), ss.subcategory)             as subcategory,
  ss.item_code,
  coalesce(nullif(trim(im.item_name), ''), ss.item_name)                 as item_name,
  coalesce(nullif(trim(im.shade_name), ''), ss.shade_name)               as shade_name,
  ss.size, ss.closing_stock, ss.rate,
  sl.scheme_name,
  sl.discount_pct,
  coalesce(sl.is_discounted_50plus, false) as is_eoss
from raw_logic.stock_snapshot ss
left join raw_logic.item_master im on im.item_code = ss.item_code
left join raw_logic.scheme_lookup sl on sl.item_code = ss.item_code;

comment on view sales.vw_stock_with_scheme is
  'Stock snapshot rows enriched with scheme/EOSS info (0024) and, as of 0056, product-attribute fields (item_name, shade_name, season, market_segment, gender, size_group, subcategory) sourced from raw_logic.item_master by barcode (item_code) join, falling back to the stock snapshot''s own value for any barcode not yet in item_master. rate stays the only price field — item_master.mrp is never read here or anywhere else in the app.';

grant select on sales.vw_stock_with_scheme to authenticated;
