-- =============================================================================
-- 0050 · Semantic-layer grain corrections + scheme/hourly metric coverage.
--        CATALOGUE ONLY. This migration does not create, replace, or alter a
--        single view, function, or number that any page renders. It corrects
--        workspace.metric_definitions rows that DESCRIBED production
--        inaccurately, and adds rows for source columns that were already
--        being queried but had no catalogue entry.
--
--        Per Objective.md's non-negotiable rule: no business logic changes.
--        Where production is internally inconsistent (see ATV below), this
--        migration DOCUMENTS the inconsistency rather than resolving it —
--        resolving it would change a displayed number, which is a business
--        ruling, not a migration.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- THE ATV GRAIN DEFECT (the reason this migration exists)
--
-- 0048 catalogued atv/upt/discount_pct against sales.vw_ebo_sales_daily. For
-- upt and discount_pct that is harmless — those two are defined identically
-- at both grains, so re-deriving them from their components (which the
-- rollup_strategy already mandates) lands on the same number either way.
--
-- ATV is NOT. The two views use DIFFERENT NUMERATORS:
--
--   daily  (0005:106)  atv = round(sale_net_amount / nullif(sale_bills,0), 2)
--                            ^^^^^^^^^^^^^^^ sum(net_amount) FILTER (bill_type='SALE')
--
--   weekly (0005:133)  atv = round(sum(net_sales) / nullif(sum(sale_bills),0), 2)
--                                  ^^^^^^^^^ ALL bill types — returns included
--
-- So daily ATV is "average value of a sale bill" and weekly ATV is "net
-- revenue per sale bill, after returns are netted off." On any store/period
-- containing a RETURN bill these are different numbers. They agree only when
-- returns_value = 0.
--
-- What the app actually SHOWS is the WEEKLY definition. Both the Network
-- page and the Workspace's Sales KPI grid compute network ATV in TypeScript
-- as totalNetSales / totalSaleBills over WEEKLY rows
-- (web/lib/sales/aggregate.ts:38, computeSalesTotals), and the per-store
-- league table does the same (aggregate.ts:100). Nothing in the app reads
-- sales.vw_ebo_sales_daily.atv at all.
--
-- 0048's own row was therefore self-contradictory: its source_column pointed
-- at the daily column, while its rollup_strategy said
-- "re-derive: sum(net_sales) / sum(sale_bills)" — which is the WEEKLY rule.
-- The rollup_strategy was right about production; source_view/source_column
-- and source_expression were wrong.
--
-- Why this was never caught: the parity fixture (BO-001 / 2026-08-10) has
-- 2 SALE bills and ZERO return bills, so both formulas produce 700 there.
-- The fixture cannot distinguish them by construction. Noted in the
-- verified_against text below so the next person doesn't read a green
-- parity run as proof the grain question was settled.
--
-- Consequence if left uncorrected: routing the Sales KPI grid or Store
-- League table through the Phase 4 query planner would have selected
-- sales.vw_ebo_sales_daily.atv and silently displayed a DIFFERENT ATV than
-- /network shows for the same scope — exactly the "two pages disagree"
-- failure the semantic layer exists to prevent.
--
-- NOTE the daily view does not even expose sale_net_amount as an output
-- column (it lives only in the bill_totals CTE, 0005:91), so daily-grain ATV
-- is not re-derivable from vw_ebo_sales_daily's public columns at all. Only
-- the weekly definition can be recomputed from exposed columns. That is an
-- additional reason to point the catalogue at the weekly view rather than
-- "fix" it by exposing a new column (which would be a view change).
-- -----------------------------------------------------------------------------

update workspace.metric_definitions set
  source_view       = 'sales.vw_ebo_sales_weekly',
  source_column     = 'atv',
  source_expression = 'round(sum(net_sales) / nullif(sum(sale_bills), 0), 2)',
  rollup_strategy   = 're-derive: sum(net_sales) / sum(sale_bills) — never average ATV values. '
                      'net_sales here is ALL bill types (returns netted off), NOT sale-bills-only; '
                      'sales.vw_ebo_sales_daily.atv uses a sale-bills-only numerator and is a '
                      'DIFFERENT metric that no page renders. See migration 0050 header.',
  provenance        = '0005_sales_rollup_views.sql:133 (weekly view); matches web/lib/sales/aggregate.ts:38,100 which is what the app renders',
  is_verified       = false,
  verified_against  = 'RETRACTED by 0050: the prior parity run used a fixture with zero RETURN bills, '
                      'where the daily and weekly ATV formulas coincide — it could not distinguish them. '
                      'Re-verify against a fixture containing at least one RETURN bill before trusting this flag.'
where id = 'atv';

-- upt and discount_pct: the FORMULA was already correct and grain-independent,
-- but both were catalogued against the daily view while every consumer reads
-- the weekly one. Repointed for consistency with the app (and so a planner
-- grouping ATV+UPT+discount% lands them all in ONE query against ONE view
-- instead of splitting across two). No numeric change: sum(sale_quantity)/
-- sum(sale_bills) and 100*sum(discount)/sum(gross_sales) are identical
-- whether summed from daily rows or read from the weekly rollup.
update workspace.metric_definitions set
  source_view       = 'sales.vw_ebo_sales_weekly',
  source_column     = 'upt',
  source_expression = 'round(sum(sale_quantity) / nullif(sum(sale_bills), 0)::numeric, 3)',
  provenance        = '0005_sales_rollup_views.sql:136 (weekly view); identical in form to the daily view''s 0005:107'
where id = 'upt';

update workspace.metric_definitions set
  source_view       = 'sales.vw_ebo_sales_weekly',
  source_column     = 'discount_pct',
  source_expression = 'round(100.0 * sum(discount) / nullif(sum(gross_sales), 0), 2)',
  provenance        = '0005_sales_rollup_views.sql:134 (weekly view); identical in form to the daily view''s 0005:108'
where id = 'discount_pct';

-- is_complete_week was already correctly pointed at the weekly view; restate
-- its provenance line only so all four weekly-sourced metrics cite the same
-- view consistently. No field that affects planning changes.
update workspace.metric_definitions set
  provenance = '0005_sales_rollup_views.sql:126 (weekly view)'
where id = 'is_complete_week';


-- -----------------------------------------------------------------------------
-- Sale-bills-only ATV, catalogued as its OWN metric rather than pretending it
-- is the same one. The daily view computes it (0005:106) and it is a
-- legitimate, meaningful figure ("what did an average sale bill ring up,
-- ignoring returns") — it simply is not what any page currently displays.
--
-- Registered so that the divergence is representable in the catalogue instead
-- of being a footnote, and so a future component that genuinely wants the
-- returns-excluded figure has a governed id to ask for rather than quietly
-- repointing 'atv'.
--
-- is_verified stays false: nothing has parity-checked this against a page,
-- because no page shows it.
-- -----------------------------------------------------------------------------
insert into workspace.metric_definitions
  (id, label, description, unit, decimals, source_kind, source_view, source_column, source_expression, rollup_strategy, requires_metrics, provenance) values
  ('atv_sale_bills_only', 'ATV (sale bills only)',
   'Average value of a SALE bill, with return bills excluded from the numerator entirely — as opposed to "atv", which nets returns off the numerator and is the figure the app renders. Equal to atv only when the scope contains no return bills.',
   'currency_inr', 2, 'view_column', 'sales.vw_ebo_sales_daily', 'atv',
   'round(sale_net_amount / nullif(sale_bills, 0), 2)  -- sale_net_amount = sum(net_amount) filter (where bill_type = ''SALE'')',
   're-derive from sale-bills-only net amount / sale_bills. NOT re-derivable from vw_ebo_sales_daily''s exposed columns — sale_net_amount is CTE-internal (0005:91) — so this metric can only be read at the daily grain, never rolled up from it.',
   array['sale_bills'],
   '0005_sales_rollup_views.sql:106 (daily view)')
on conflict (id) do nothing;


-- -----------------------------------------------------------------------------
-- Scheme + hourly coverage. Both views are ALREADY queried on every render of
-- the Network page and the Workspace (SchemePenetration, HourlySalesChart),
-- but neither had a single metric_definitions row — so the Phase 4 planner
-- had nothing to resolve against and those fetches had to stay hand-written.
-- Adding the rows is what makes them plannable.
--
-- Both views' date and store columns are already registered in the planner's
-- VIEW_DATE_COLUMN / VIEW_STORE_COLUMN lookups
-- (web/lib/workspace/queryPlanner.ts), so no planner change is needed for
-- these to resolve.
-- -----------------------------------------------------------------------------
insert into workspace.metric_definitions
  (id, label, description, unit, decimals, source_kind, source_view, source_column, source_expression, rollup_strategy, requires_metrics, provenance) values

  ('scheme_quantity', 'Units sold on scheme', 'Units sold per scheme group per day, SALE bills only. Rows with no scheme carry the literal group ''NO SCHEME'' rather than null.', 'count', 0, 'view_column', 'sales.vw_ebo_scheme_daily', 'quantity',
   'sum(quantity) filter (where bill_type = ''SALE'')', null, '{}', '0005_sales_rollup_views.sql:174'),

  ('scheme_net_sales', 'Net sales on scheme', 'Net sales per scheme group per day, SALE bills only.', 'currency_inr', 0, 'view_column', 'sales.vw_ebo_scheme_daily', 'net_sales',
   'sum(net_amount) filter (where bill_type = ''SALE'')', null, '{}', '0005_sales_rollup_views.sql:177'),

  ('hourly_net_sales', 'Net sales by hour', 'Net sales bucketed by hour of day. SALE lines with a non-null bill_time only — bills with no recorded time are absent, not zero, so this does not reconcile to daily net_sales.', 'currency_inr', 0, 'view_column', 'sales.vw_ebo_sales_hourly', 'net_sales',
   'sum(net_amount) where bill_type = ''SALE'' and bill_time is not null, grouped by extract(hour from bill_time)', null, '{}', '0017_agent_and_hourly_views.sql:27-38')
on conflict (id) do nothing;


-- -----------------------------------------------------------------------------
-- Dimension coverage for the two views above. 'scheme_group' and
-- 'hour_of_day' already exist (0048:101,103); only the scheme view's own
-- date/store grain needed no new entry. Nothing to add — recorded here so the
-- next reader doesn't re-check.
-- -----------------------------------------------------------------------------


-- PostgREST caches the schema; without this it keeps serving the old shape.
notify pgrst, 'reload schema';
