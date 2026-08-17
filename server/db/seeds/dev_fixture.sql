-- =============================================================================
-- LOCAL DEV FIXTURE — NOT A MIGRATION. Never run this against production.
--
-- Generates a realistic-but-synthetic sales dataset so the app has something
-- to render and so the metrics that were previously untestable become
-- testable. Before this, the local dataset was 2 SALE lines: no returns, no
-- scheme groups, no parseable bill times, one store, one day.
--
-- Idempotent: every row it writes is tagged (bill numbers are 'SB-F…' /
-- 'RB-F…' / 'EX-F…', footfall rows carry remarks = 'dev_fixture'), and it
-- deletes its own previous output before regenerating. Re-run freely.
--
-- The tag is an INFIX, not a prefix change: the bill number must still contain
-- the literal 'SB-' / 'RB-' that bill_type classification keys on (0036), so
-- the marker goes AFTER the dash. 'SBF-…' would tag correctly and classify as
-- OTHER — see the summary query at the foot of this file.
--
-- =============================================================================
-- WHAT IT DELIBERATELY DOES *NOT* TOUCH
-- =============================================================================
-- BO-001 on 2026-08-10 is the parity fixture. web/scripts/parity-check.mjs
-- asserts exact values against that store/day (2 sale bills, gross 1500, net
-- 1400, discount 100, qty 3, ATV 700, UPT 1.5, discount% 6.67, footfall 20
-- -> conversion 10%, sales/footfall 70). Those numbers were confirmed
-- against the live Network page. Adding a single line to that day would
-- silently invalidate the one independently-verified reference point this
-- project has, so this script skips it entirely.
--
-- =============================================================================
-- TWO FORMAT FACTS THAT DRIVE THE GENERATED VALUES
-- =============================================================================
-- 1. bill_time is only parsed when it matches '^\d{2}:\d{2}:\d{2} (AM|PM)$'
--    (sales.vw_ebo_sales_lines, from 0004). The pre-existing fixture rows
--    store 24-hour times like '14:30:00', which fail that regex, become NULL,
--    and are therefore dropped from sales.vw_ebo_sales_hourly entirely --
--    which is why the hourly chart rendered empty and parity reported
--    "zero hourly rows". This script writes 12-hour AM/PM times so the hourly
--    view actually populates. The pre-existing rows are left as they are;
--    whether the real ERP export uses 24-hour is a question for whoever owns
--    that feed, and "silently NULL" is arguably the wrong failure mode.
--
-- 2. bill_type is derived from bill_no: '%SB-%' -> SALE, '%RB-%' -> RETURN,
--    everything else -> OTHER (0036). All three are generated here.
--
-- =============================================================================
-- WHERE RETURN AND OTHER BILLS ARE PLACED, AND WHY IT MATTERS
-- =============================================================================
-- RETURN bills are seeded across the range INCLUDING retail week 33
-- (2026-08-10..2026-08-16, the week containing the parity fixture day, but
-- never on that day). This is the point of the exercise: with returns in
-- scope, sales.vw_ebo_sales_daily.atv (sale-bills-only numerator, 0005:106)
-- and sales.vw_ebo_sales_weekly.atv (returns-netted numerator, 0005:133)
-- finally produce DIFFERENT numbers, so the parity harness can discriminate
-- them instead of passing vacuously. See Objective.md open decision #3.
--
-- OTHER bills are placed ONLY in July, deliberately OUTSIDE week 33.
-- parity-check.mjs asserts the identity
--     daily.atv == (net_sales - returns_value) / sale_bills
-- over the fixture week. That identity holds only when no OTHER-type bills
-- are present, because net_sales - returns_value = SALE + OTHER (see
-- migration 0051). Seeding OTHER bills into week 33 would make that
-- assertion fail correctly but unhelpfully, turning a green regression suite
-- red for a documented reason. Keeping them in July preserves the harness
-- while still exercising the OTHER path in the wider dataset.
-- =============================================================================

\set ON_ERROR_STOP on

begin;

-- ---------------------------------------------------------------------------
-- Clear this script's own previous output only. The '-F' infix is the tag; the
-- two original SB-1001/SB-1002 rows don't match and survive untouched, as does
-- their footfall row (source 'manual').
-- ---------------------------------------------------------------------------
delete from raw_logic.sales_transactions
where bill_no like 'SB-F%' or bill_no like 'RB-F%' or bill_no like 'EX-F%';
-- ops.ebo_footfall_daily.source is CHECK-constrained to manual/erp/sensor, so
-- the fixture tag lives in remarks (unconstrained) rather than source. Seeded
-- rows claim 'sensor', which is what a door counter would report for a bulk
-- daily count; the pre-existing parity row is 'manual' and is not matched here.
delete from ops.ebo_footfall_daily where remarks = 'dev_fixture';

-- ---------------------------------------------------------------------------
-- Day x store spine. 2026-07-19 .. 2026-08-15 covers the 28-day window the
-- Workspace and Network pages default to, so both pages have data on load.
-- ---------------------------------------------------------------------------
create temporary table _spine on commit drop as
select
  s.store_id,
  s.branch_name_erp,
  d::date as day,
  -- Deterministic per (store, day) pseudo-randomness: same input always
  -- yields the same fixture, so a re-run doesn't churn every number and
  -- invalidate a screenshot someone just took.
  --
  -- Cast to bigint BEFORE abs(): hashtext() can return -2147483648, whose
  -- absolute value does not fit in int4 and raises "integer out of range".
  -- The modulo then keeps h small enough that the arithmetic below cannot
  -- overflow either.
  (abs(hashtext(s.store_id || d::text)::bigint) % 100000)::int as h
from core.stores s
cross join generate_series('2026-07-19'::date, '2026-08-15'::date, interval '1 day') d
where s.is_active
  -- The one exclusion that protects the parity fixture.
  and not (s.store_id = 'BO-001' and d::date = '2026-08-10');

-- ---------------------------------------------------------------------------
-- SALE bills. 4-11 bills per store-day, 1-3 lines each, weekends busier.
-- ---------------------------------------------------------------------------
insert into raw_logic.sales_transactions
  (branch_name, bill_date, bill_no, item_code, total_quantity, gross_amount, net_amount,
   scheme_name, scheme_group_name, agent_name, bill_time, line_seq,
   shade_name, pack_size, category, subcategory, season, market_segment, gender, size_group, mrp)
select
  sp.branch_name_erp,
  to_char(sp.day, 'DD/MM/YYYY'),
  'SB-F' || to_char(sp.day, 'YYYYMMDD') || '-' || sp.store_id || '-' || b::text,
  'ITEM-' || chr(65 + ((sp.h + b * 7 + l) % 12)),
  qty.q,
  gross.g,
  -- Discount on roughly half of lines, 5-40% off, otherwise net = gross.
  case when (sp.h + b * 13 + l) % 2 = 0
       then round(gross.g * (1 - ((5 + ((sp.h + b * 3 + l) % 36))::numeric / 100)), 2)
       else gross.g end,
  scheme.name,
  scheme.grp,
  'AGENT-' || (1 + ((sp.h + b) % 4))::text,
  -- 12-hour AM/PM so bill_time actually parses (see header fact #1).
  -- Trading hours 10am-9pm.
  to_char(make_time(10 + ((sp.h + b * 5) % 11), (sp.h + b * 17 + l * 11) % 60, 0), 'HH12:MI:SS AM'),
  l,
  (array['Black','Navy','Rust','Olive','Ivory','Teal'])[1 + ((sp.h + b + l) % 6)],
  (array['1','2','3'])[1 + ((sp.h + l) % 3)],
  (array['Apparel','Apparel','Apparel','Accessories'])[1 + ((sp.h + b) % 4)],
  (array['Tops','Bottoms','Dresses','Outerwear','Bags'])[1 + ((sp.h + b * 2 + l) % 5)],
  (array['SS26','AW25','SS26','CORE'])[1 + ((sp.h + b) % 4)],
  (array['Premium','Value','Core'])[1 + ((sp.h + b) % 3)],
  (array['FEMALE','FEMALE','MALE','KIDS'])[1 + ((sp.h + b * 3) % 4)],
  (array['S','M','L','XL','FREE'])[1 + ((sp.h + b + l * 2) % 5)],
  gross.g
from _spine sp
cross join lateral (
  select generate_series(1,
    4 + (sp.h % 5) + case when extract(dow from sp.day) in (0, 6) then 3 else 0 end
  ) as b
) bills
cross join lateral (select generate_series(1, 1 + ((sp.h + b) % 3)) as l) lines
cross join lateral (select (1 + ((sp.h + b * 3 + l) % 3))::numeric as q) qty
cross join lateral (select (399 + ((sp.h + b * 137 + l * 61) % 34) * 100)::numeric as g) gross
cross join lateral (
  select
    case (sp.h + b) % 4 when 0 then 'FLAT30' when 1 then 'BOGO' when 2 then 'EOSS' else null end as name,
    case (sp.h + b) % 4 when 0 then 'FLAT DISCOUNT' when 1 then 'BUY ONE GET ONE' when 2 then 'END OF SEASON' else null end as grp
) scheme;

-- ---------------------------------------------------------------------------
-- RETURN bills. Roughly one store-day in three has a return, one line each.
-- Quantities and amounts are NEGATIVE, matching how a return reduces
-- net_sales in the rollups (0005 sums net_amount across all bill types).
--
-- These are what make the ATV grain question empirically testable — see the
-- header. Intentionally present in week 33.
-- ---------------------------------------------------------------------------
insert into raw_logic.sales_transactions
  (branch_name, bill_date, bill_no, item_code, total_quantity, gross_amount, net_amount,
   scheme_name, scheme_group_name, agent_name, bill_time, line_seq,
   shade_name, pack_size, category, subcategory, season, market_segment, gender, size_group, mrp)
select
  sp.branch_name_erp,
  to_char(sp.day, 'DD/MM/YYYY'),
  'RB-F' || to_char(sp.day, 'YYYYMMDD') || '-' || sp.store_id,
  'ITEM-' || chr(65 + (sp.h % 12)),
  -(1 + (sp.h % 2))::numeric,
  -(699 + (sp.h % 12) * 100)::numeric,
  -(699 + (sp.h % 12) * 100)::numeric,
  null, null,
  'AGENT-' || (1 + (sp.h % 4))::text,
  to_char(make_time(11 + (sp.h % 9), (sp.h * 7) % 60, 0), 'HH12:MI:SS AM'),
  1,
  (array['Black','Navy','Rust','Olive','Ivory','Teal'])[1 + (sp.h % 6)],
  '1',
  'Apparel',
  (array['Tops','Bottoms','Dresses'])[1 + (sp.h % 3)],
  'SS26', 'Core',
  (array['FEMALE','MALE'])[1 + (sp.h % 2)],
  (array['S','M','L'])[1 + (sp.h % 3)],
  (699 + (sp.h % 12) * 100)::numeric
from _spine sp
where sp.h % 3 = 0;

-- ---------------------------------------------------------------------------
-- OTHER bills (bill_no matching neither SB- nor RB-). July only — see the
-- header for why these must stay out of retail week 33.
-- ---------------------------------------------------------------------------
insert into raw_logic.sales_transactions
  (branch_name, bill_date, bill_no, item_code, total_quantity, gross_amount, net_amount,
   scheme_name, scheme_group_name, agent_name, bill_time, line_seq,
   shade_name, pack_size, category, subcategory, season, market_segment, gender, size_group, mrp)
select
  sp.branch_name_erp,
  to_char(sp.day, 'DD/MM/YYYY'),
  'EX-F' || to_char(sp.day, 'YYYYMMDD') || '-' || sp.store_id,
  'ITEM-X',
  1::numeric,
  (1200 + (sp.h % 5) * 100)::numeric,
  (1200 + (sp.h % 5) * 100)::numeric,
  null, null,
  'AGENT-1',
  to_char(make_time(12 + (sp.h % 6), 0, 0), 'HH12:MI:SS AM'),
  1,
  'Ivory', '1', 'Apparel', 'Tops', 'CORE', 'Core', 'FEMALE', 'M',
  (1200 + (sp.h % 5) * 100)::numeric
from _spine sp
where sp.day < '2026-08-01'
  and sp.h % 9 = 0;

-- ---------------------------------------------------------------------------
-- Footfall, so conversion % and sales-per-footfall render. Loosely correlated
-- with that day's bill count (25-60 visitors per sale bill) rather than
-- random, so conversion lands in a plausible 2-8% band instead of nonsense.
-- ---------------------------------------------------------------------------
insert into ops.ebo_footfall_daily (store_id, date, footfall, source, remarks)
select
  sp.store_id,
  sp.day,
  greatest(15, (count(distinct st.bill_no) * (25 + (sp.h % 36)))::int),
  'sensor',
  'dev_fixture'
from _spine sp
left join raw_logic.sales_transactions st
  on st.branch_name = sp.branch_name_erp
 and st.bill_date = to_char(sp.day, 'DD/MM/YYYY')
 and st.bill_no like 'SB-F%'
group by sp.store_id, sp.day, sp.h;

commit;

-- ---------------------------------------------------------------------------
-- Summary
-- ---------------------------------------------------------------------------
-- These patterns MUST stay byte-identical to sales.vw_ebo_sales_lines (0036):
-- '%SB-%' and '%RB-%', dash included. An earlier draft of this script summarised
-- with '%SB%'/'%RB%' (no dash) while generating bill numbers prefixed 'SBF-'/
-- 'RBF-'. Those match '%SB%' but NOT '%SB-%', so every seeded bill was
-- classified OTHER by the actual view while this summary cheerfully reported
-- them as SALE — the seed looked correct and produced zero sale bills and zero
-- returns. Never summarise with a looser pattern than the thing being verified.
select
  case
    when bill_no like '%SB-%' then 'SALE'
    when bill_no like '%RB-%' then 'RETURN'
    else 'OTHER'
  end as bill_type,
  count(*) as lines,
  count(distinct bill_no) as bills,
  -- bill_date is TEXT in DD/MM/YYYY, so min/max on it would sort
  -- lexicographically ("01/08" < "31/07") and report nonsense. Parse first.
  min(to_date(bill_date, 'DD/MM/YYYY')) as first_date,
  max(to_date(bill_date, 'DD/MM/YYYY')) as last_date
from raw_logic.sales_transactions
group by 1 order by 2 desc;

select 'footfall rows: ' || count(*)::text as summary from ops.ebo_footfall_daily;
