-- =============================================================================
-- 0048 · Phase 3: Semantic Layer (Retail Intelligence Workspace blueprint,
--        §I). Additive only. Every KPI formula catalogued here is copied
--        VERBATIM from either a live SQL view/function (quoted with its
--        migration file:line) or, where no SQL definition exists yet, from
--        the TypeScript that currently computes it (also cited by
--        file:line) — never re-derived from first principles. This table is
--        the single place a future component/query-planner will read "what
--        does ATV mean" from; it does not replace or alter the SQL/JS that
--        actually computes these numbers today.
--
-- is_verified = true means: a parity check (web/lib/workspace/__parity__)
-- has run this metric's `source` against the equivalent live page output for
-- the same inputs and confirmed an exact match. Nothing in this migration
-- may be trusted by a future consumer until that flag is true — most rows
-- below ship false, which is the honest state on the day this was written.
-- =============================================================================

create table workspace.metric_definitions (
  id                  text primary key,          -- e.g. 'net_sales', 'atv'
  label               text not null,
  description         text not null,
  unit                text not null check (unit in ('currency_inr', 'count', 'percent', 'percentage_points', 'ratio', 'days', 'score', 'text')),
  decimals            int not null default 0,

  -- Where the number actually comes from today.
  source_kind         text not null check (source_kind in ('view_column', 'sql_expression', 'js_computed')),
  source_view         text,                       -- 'schema.view_or_function' when applicable
  source_column       text,                       -- column name when source_kind = 'view_column'
  source_expression   text,                       -- the literal SQL or TS expression, quoted verbatim

  -- How to roll this metric UP across a coarser grain. Ratio metrics
  -- (ATV, UPT, discount %, conversion %) can NEVER be averaged across rows —
  -- they must be re-derived from their numerator/denominator components.
  -- Null means "plain sum" is correct (net_sales, sale_bills, etc.).
  rollup_strategy     text,
  requires_metrics    text[] not null default '{}', -- component metrics needed to re-derive this one

  provenance          text not null,              -- migration/file:line this formula was copied from
  verified_against    text,                       -- page/file:line it was cross-checked against, once verified
  is_verified         boolean not null default false,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table workspace.metric_definitions is
  'Phase 3 semantic layer — the single catalogue of KPI formulas, copied verbatim from their live SQL/TS source. Nothing consumes this table yet (Phase 4/5 work). is_verified=false is the honest default; see migration 0048 header.';

create table workspace.dimension_definitions (
  id                  text primary key,          -- e.g. 'store', 'retail_week'
  label               text not null,
  description         text not null,
  source_kind         text not null check (source_kind in ('view_column', 'calendar', 'lookup')),
  source_view         text,
  source_column       text,
  provenance          text not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table workspace.dimension_definitions is
  'Phase 3 semantic layer — governed dimension catalogue, same posture as metric_definitions.';

create trigger set_updated_at
  before update on workspace.metric_definitions
  for each row execute function extensions.moddatetime(updated_at);
create trigger set_updated_at
  before update on workspace.dimension_definitions
  for each row execute function extensions.moddatetime(updated_at);

alter table workspace.metric_definitions enable row level security;
alter table workspace.dimension_definitions enable row level security;

create policy metric_definitions_read on workspace.metric_definitions for select using (true);
create policy metric_definitions_write on workspace.metric_definitions for all
  using (core.fn_user_role() = 'super_admin') with check (core.fn_user_role() = 'super_admin');

create policy dimension_definitions_read on workspace.dimension_definitions for select using (true);
create policy dimension_definitions_write on workspace.dimension_definitions for all
  using (core.fn_user_role() = 'super_admin') with check (core.fn_user_role() = 'super_admin');

-- SELECT is open to every authenticated user (non-sensitive catalogue data);
-- INSERT/UPDATE/DELETE are granted here too because RLS — not the base
-- GRANT — is what actually restricts writes to super_admin (see the
-- *_write policies above). A SELECT-only grant would block a super_admin's
-- write before RLS is ever evaluated, which is exactly the gap this
-- migration hit on first deploy (PostgREST returned 42501 "permission
-- denied", not an RLS-shaped 0-rows-updated) — fixed here rather than left
-- for the next person to rediscover.
grant select, insert, update, delete on workspace.metric_definitions, workspace.dimension_definitions to authenticated;
grant all on workspace.metric_definitions, workspace.dimension_definitions to service_role;

-- -----------------------------------------------------------------------------
-- Dimensions — every one backed by a real, currently-queried column.
-- -----------------------------------------------------------------------------
insert into workspace.dimension_definitions (id, label, description, source_kind, source_view, source_column, provenance) values
  ('date', 'Date', 'Calendar day, YYYY-MM-DD.', 'view_column', 'sales.vw_ebo_sales_daily', 'bill_date', '0004_sales_base_view.sql'),
  ('retail_week', 'Retail week', 'Mon-Sun retail week, ISO week/year via core.retail_calendar.', 'calendar', 'core.retail_calendar', 'retail_week', '0002_retail_calendar.sql'),
  ('store', 'Store', 'core.stores.store_id, the RLS-scoped store dimension.', 'view_column', 'core.stores', 'store_id', '0003_core_stores_rbac.sql'),
  ('scheme_group', 'Scheme group', 'Discount scheme grouping, NO SCHEME when unset.', 'view_column', 'sales.vw_ebo_scheme_daily', 'scheme_group', '0005_sales_rollup_views.sql:514-525'),
  ('agent', 'Agent', 'Billing agent name (branch-code prefix stripped for display in JS, raw value stored).', 'view_column', 'sales.vw_ebo_agent_daily', 'agent_name', '0017_agent_and_hourly_views.sql:1484-1500'),
  ('hour_of_day', 'Hour of day', 'extract(hour from bill_time), SALE lines with non-null bill_time only.', 'view_column', 'sales.vw_ebo_sales_hourly', 'bill_hour', '0017_agent_and_hourly_views.sql:1502-1516'),
  ('gender', 'Gender', 'Item gender from stock-snapshot lookup, join on item_code.', 'view_column', 'sales.vw_item_gender_options', 'gender', '0029_targets_gender_subcategory_filter.sql'),
  ('category', 'Category', 'Point-of-sale category off raw_logic.sales_transactions.category, not a stock join.', 'view_column', 'sales.vw_sale_category_options', 'category', '0030_sale_transactions_item_attributes.sql'),
  ('style', 'Style No.', 'item_name from the stock snapshot, used as the style code in Replenishment/Mix.', 'view_column', 'sales.vw_stock_with_scheme', 'item_name', '0024_erp_report_processing.sql'),
  ('color', 'Color', 'shade_name from the stock snapshot.', 'view_column', 'sales.vw_stock_with_scheme', 'shade_name', '0024_erp_report_processing.sql'),
  ('age_segment', 'Age segment', 'Baby/Kids segment used in display-capacity planning.', 'view_column', 'ops.stock_display_capacity', 'age_segment', '0026_stock_display_capacity.sql')
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- Metrics — SQL-sourced, quoted verbatim from the Phase 0 business-logic
-- register. rollup_strategy documents why a ratio can't just be summed/avg'd.
-- -----------------------------------------------------------------------------
insert into workspace.metric_definitions
  (id, label, description, unit, decimals, source_kind, source_view, source_column, source_expression, rollup_strategy, requires_metrics, provenance) values

  ('net_sales', 'Net sales', 'Net sales value.', 'currency_inr', 0, 'view_column', 'sales.vw_ebo_sales_daily', 'net_sales',
   'sum(coalesce(net_amount, gross_amount))', null, '{}', '0036_bill_type_new_bill_no_format.sql:45'),

  ('gross_sales', 'Gross sales', 'Gross sales value before discount.', 'currency_inr', 0, 'view_column', 'sales.vw_ebo_sales_daily', 'gross_sales',
   'sum(gross_amount)', null, '{}', '0005_sales_rollup_views.sql:433'),

  ('discount_value', 'Discount given', 'Discount amount in rupees.', 'currency_inr', 0, 'view_column', 'sales.vw_ebo_sales_daily', 'discount',
   'gross_amount - coalesce(net_amount, gross_amount)', null, '{}', '0036_bill_type_new_bill_no_format.sql:46'),

  ('discount_pct', 'Discount %', 'Discount as a percentage of gross sales.', 'percent', 1, 'view_column', 'sales.vw_ebo_sales_daily', 'discount_pct',
   'round(100.0 * discount / nullif(gross_sales, 0), 2)', 're-derive: 100 * sum(discount_value) / sum(gross_sales) — never average the per-row %', array['discount_value','gross_sales'], '0005_sales_rollup_views.sql:454'),

  ('sale_bills', 'Sale bills', 'Count of SALE bills (bill_type = SALE, excludes RETURN/OTHER).', 'count', 0, 'view_column', 'sales.vw_ebo_sales_daily', 'sale_bills',
   'count distinct bill_no where bill_type = SALE', null, '{}', '0005_sales_rollup_views.sql:412-460'),

  ('sale_quantity', 'Units sold', 'Net units sold (SALE bills only).', 'count', 0, 'view_column', 'sales.vw_ebo_sales_daily', 'sale_quantity',
   'sum(total_quantity) where bill_type = SALE', null, '{}', '0005_sales_rollup_views.sql:412-460'),

  ('atv', 'ATV', 'Average Transaction Value — net sales per sale bill.', 'currency_inr', 2, 'view_column', 'sales.vw_ebo_sales_daily', 'atv',
   'round(sale_net_amount / nullif(sale_bills, 0), 2)', 're-derive: sum(net_sales) / sum(sale_bills) — never average daily ATV values', array['net_sales','sale_bills'], '0005_sales_rollup_views.sql:452'),

  ('upt', 'UPT', 'Units Per Transaction.', 'ratio', 2, 'view_column', 'sales.vw_ebo_sales_daily', 'upt',
   'round(sale_quantity / nullif(sale_bills, 0)::numeric, 3)', 're-derive: sum(sale_quantity) / sum(sale_bills)', array['sale_quantity','sale_bills'], '0005_sales_rollup_views.sql:453'),

  ('is_complete_week', 'Complete week flag', 'Whether a retail week has all 7 days of data.', 'text', 0, 'view_column', 'sales.vw_ebo_sales_weekly', 'is_complete_week',
   '(max(bill_date) - min(week_start))::int >= 6', null, '{}', '0005_sales_rollup_views.sql:472'),

  ('footfall', 'Footfall', 'Manually entered daily footfall count.', 'count', 0, 'view_column', 'ops.vw_ebo_conversion_daily', 'footfall',
   'ops.ebo_footfall_daily.footfall, LEFT JOINed — NULL (not 0) on days with no entry', null, '{}', '0006_footfall.sql:586-600'),

  ('conversion_pct', 'Conversion %', 'Sale bills as a percentage of footfall.', 'percent', 2, 'view_column', 'ops.vw_ebo_conversion_daily', 'conversion_pct',
   'case when footfall > 0 then round(100.0 * sale_bills / footfall, 2) end', 're-derive: 100 * sum(sale_bills) / sum(footfall)', array['sale_bills','footfall'], '0006_footfall.sql:595-597'),

  ('sales_per_footfall', 'Sales per footfall', 'Net sales divided by footfall.', 'currency_inr', 2, 'view_column', 'ops.vw_ebo_conversion_daily', 'sales_per_footfall',
   'case when footfall > 0 then round(net_sales / footfall, 2) end', 're-derive: sum(net_sales) / sum(footfall)', array['net_sales','footfall'], '0006_footfall.sql:598-600'),

  ('achievement_pct', 'Achievement %', 'MTD sales as a percentage of the monthly target.', 'percent', 2, 'view_column', 'ops.vw_ebo_target_achievement', 'achievement_pct',
   'round(100.0 * coalesce(mtd_sales, 0) / nullif(target_sales, 0), 2)', 're-derive from mtd_sales/target_sales, never average daily achievement%', array['net_sales'], '0007_targets.sql:679'),

  ('required_daily_run_rate', 'Required daily run rate', 'Sales/day needed for the rest of the month to hit target.', 'currency_inr', 2, 'view_column', 'ops.vw_ebo_target_achievement', 'required_daily_run_rate',
   '(target_sales - mtd_sales) / nullif(greatest(period_end - current_date, 0) + 1, 0)', null, '{}', '0007_targets.sql:683-688'),

  ('store_health_score', 'Store health score', 'Weighted 0-100 composite of sales growth, target achievement, footfall growth, conversion, ATV/UPT vs network.', 'score', 1, 'sql_expression', 'ops.fn_compute_store_health', null,
   'round(sum(factor_score*weight) / nullif(sum(weight) filter (where factor_score is not null), 0), 1); weights: sales_growth_wow .25, target_achievement .25, footfall_growth_wow .15, conversion_pct .15, atv_vs_network .10, upt_vs_network .10',
   null, array['net_sales','footfall','conversion_pct','atv'], '0008_store_health.sql:719-725,789-832'),

  ('fresh_actual_qty', 'Fresh actual qty', 'Units sold at <49.5% discount-of-gross this month, live tracker function.', 'count', 0, 'sql_expression', 'ops.fn_monthly_fresh_disc_tracker', null,
   'sum(total_quantity) filter (where gross_amount = 0 or discount_amount/gross_amount < 0.495)', null, '{}', '0037_targets_filters_multiselect_no_auto_exclude.sql:110-115'),

  ('discounted_actual_qty', 'Discounted actual qty', 'Units sold at >=49.5% discount-of-gross this month, live tracker function.', 'count', 0, 'sql_expression', 'ops.fn_monthly_fresh_disc_tracker', null,
   'sum(total_quantity) filter (where gross_amount <> 0 and discount_amount/gross_amount >= 0.495)', null, '{}', '0037_targets_filters_multiselect_no_auto_exclude.sql:116-121'),

  ('mtd_deficit_pct', 'MTD deficit %', 'How far ahead/behind pace, as a % of the WHOLE month target (not the day''s target).', 'percent', 2, 'js_computed', null, null,
   '((cum - mtdTarget) / target) * 100', 're-derive from cumulative/target, never average daily deficit%', array['fresh_actual_qty','discounted_actual_qty'], 'app/(ho)/targets/page.tsx:108 (pct/deficitPct)'),

  ('delivery_rate', 'Delivery rate', 'Delivered ÷ sent, campaign messaging.', 'percent', 2, 'view_column', 'marketing.vw_campaign_metrics', 'delivery_rate',
   'round(100.0 * count(*) filter (where delivered) / nullif(count(*) filter (where sent), 0), 2)', null, '{}', '0010_marketing_campaigns.sql:1135'),

  ('read_rate', 'Read rate', 'Read ÷ delivered, campaign messaging.', 'percent', 2, 'view_column', 'marketing.vw_campaign_metrics', 'read_rate',
   'round(100.0 * count(*) filter (where read) / nullif(count(*) filter (where delivered), 0), 2)', null, '{}', '0010_marketing_campaigns.sql:1136')
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- Metrics — JS-computed today, NO SQL definition exists. Catalogued exactly
-- as flagged in the Phase 0 audit's "business logic duplication" section —
-- these are the highest-risk items for a future semantic-layer migration,
-- because reimplementing them from first principles could silently produce
-- different numbers than production. source_expression is copied verbatim
-- from the current TypeScript; is_verified stays false until each one is
-- actually re-derived in SQL and parity-checked, which is explicitly NOT
-- this migration's job.
-- -----------------------------------------------------------------------------
insert into workspace.metric_definitions
  (id, label, description, unit, decimals, source_kind, source_expression, rollup_strategy, requires_metrics, provenance) values

  ('wow_pct', 'Week-over-week growth', 'Growth between the last two COMPLETE retail weeks touching the selected range.', 'percent', 1, 'js_computed',
   '((lastTwo[1].net - lastTwo[0].net) / lastTwo[0].net) * 100, using only weeks where is_complete_week', null, array['net_sales','is_complete_week'], 'app/(ho)/network/page.tsx:459-469'),

  ('scheme_penetration_pct', 'Scheme penetration %', 'Share of units sold that were on ANY scheme (100 - NO SCHEME share), by quantity not line count.', 'percent', 0, 'js_computed',
   '((totalSchemeQty - noSchemeQty) / totalSchemeQty) * 100', null, array['sale_quantity'], 'app/(ho)/network/page.tsx:739-741'),

  ('footfall_completeness_pct', 'Footfall data completeness %', 'Store-days with a footfall entry, as a % of expected store-days in range.', 'percent', 0, 'js_computed',
   'enteredStoreDays / expectedStoreDays * 100', null, array['footfall'], 'app/(ho)/network/page.tsx:596-600 (from ops.vw_footfall_completeness rows)'),

  ('combined_opportunity', 'Combined opportunity (estimate)', 'Sales this store would have made at its own prior-period footfall and the BETTER of its two conversion rates, minus actual — a single non-additive ceiling, never traffic+conversion opportunity summed (they overlap).', 'currency_inr', 0, 'js_computed',
   'max(0, benchmarkFootfall * (max(convNow, benchmarkConv)/100) * atvNow - curr.net)', null, array['footfall','conversion_pct','atv','net_sales'], 'app/(ho)/network/page.tsx:640-643'),

  ('sale_mix_pct', 'Sale mix %', 'Style-color''s share of net units sold within the current store/period scope.', 'percent', 1, 'js_computed',
   'sales / totalSales * 100', null, array['sale_quantity'], 'lib/replenishment/mix.ts:197'),

  ('stock_mix_pct', 'Stock mix %', 'Style-color''s share of current STORE stock (warehouse excluded) within scope.', 'percent', 1, 'js_computed',
   'max(0, soh) / totalStock * 100', null, array['closing_stock'], 'lib/replenishment/mix.ts:198'),

  ('mix_gap_pts', 'Mix gap', 'Sale Mix % minus Stock Mix %, in percentage points — positive means selling faster than its stock share.', 'percentage_points', 1, 'js_computed',
   'saleMixPct - stockMixPct', null, array['sale_mix_pct','stock_mix_pct'], 'lib/replenishment/mix.ts:199'),

  ('priority_score', 'Replenishment priority score', '6-factor weighted composite (stockout risk, velocity, cover, sales value, trend, productivity), each a hand-tuned saturating formula, caller-adjustable weights.', 'score', 1, 'js_computed',
   'sum(factorScore_i * weight_i) / sum(weight_i), 6 factors — see file for each factor formula', null, array['closing_stock','net_sales'], 'lib/replenishment/compute.ts:244-268'),

  ('cover_days', 'Cover days', 'Current stock on hand divided by weighted daily demand.', 'days', 1, 'js_computed',
   'soh / dailyDemand', null, array['closing_stock'], 'lib/replenishment/compute.ts:336-339'),

  ('planned_capacity', 'Planned display capacity', 'Base capacity x Buffer%, then split Fresh/EOSS by Fresh% (EOSS = complement, never independently stored to avoid rounding drift).', 'count', 0, 'js_computed',
   'bufferedCapacity = round(baseCapacity * bufferPct/100); freshCapacity = round(bufferedCapacity * freshPct/100); eossCapacity = bufferedCapacity - freshCapacity', null, array['closing_stock'], 'lib/stockDetails/aggregate.ts:156-198 (defaults: buffer 110%, fresh 35%)')
on conflict (id) do nothing;
