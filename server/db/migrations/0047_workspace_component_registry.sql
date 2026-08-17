-- =============================================================================
-- 0047 · Phase 2: Component Registry (Retail Intelligence Workspace blueprint,
--        §H). Additive only — new `workspace` schema, nothing existing
--        touched. This is the FIRST piece of the governed architecture: a
--        formal catalogue of the analytical building blocks that already
--        exist on Network/Targets/Stock Details/Replenishment/Sale-Stock-Mix,
--        named and described so a future Query Planner (Phase 4) and
--        Workspace Builder (Phase 5) can be built against a fixed contract
--        instead of ad hoc page code.
--
-- Deliberately NOT in scope of this migration/phase (per the blueprint's own
-- phase order — see roadmap §L):
--   - No page has been rewired to render FROM this registry. Every page
--     still renders its own hand-written JSX exactly as Phase 1 left it.
--   - No new analytical capability. Every row below describes something
--     that is already live in the app today, not something aspirational.
--   - No drag-and-drop workspace, no user-facing config UI, no semantic
--     layer (metric definitions still live only in the SQL views/functions
--     documented in the Phase 0 business-logic register).
-- =============================================================================

create schema if not exists workspace;
grant usage on schema workspace to authenticated;

create table workspace.component_definitions (
  id                    text primary key,          -- stable slug, e.g. 'sales_kpi_grid'
  name                  text not null,              -- display name
  category              text not null,              -- 'sales' | 'footfall' | 'stock' | 'targets' | 'replenishment' | 'mix'
  description           text not null,

  -- Which existing page this was extracted from, and which PageKey
  -- (lib/auth/roles.ts) gates access to it — a registry entry can never
  -- become a side door around the existing per-page RBAC/RLS gate. Ties
  -- 1:1 to source_page today since nothing is shared across pages yet.
  source_page           text not null,
  requires_page_key     text not null,

  -- What this component currently supports — reflects ACTUAL present
  -- behavior, not an aspirational config surface. Most entries below are
  -- narrow (today's pages are not yet configurable), which is honest: the
  -- Query Planner/Smart Component work in later phases is what widens these,
  -- not this registry.
  supported_metrics     text[] not null default '{}',
  supported_dimensions  text[] not null default '{}',
  supported_comparisons text[] not null default '{}',
  supported_periods     text[] not null default '{}',
  supported_visuals     text[] not null default '{}',

  -- Layout hints for a future grid-based workspace (Phase 5) — sizing only,
  -- no positional data (that belongs to a workspace instance, not the
  -- definition).
  min_w                 int not null default 3,
  min_h                 int not null default 2,
  default_w             int not null default 6,
  default_h             int not null default 4,

  -- Cost/load hints for the future Query Planner (Phase 4) and
  -- performance-aware workspace (Phase 9) — 'high' cost / 'deferred' load
  -- both a hard-earned reminder that this row already pulls (or historically
  -- pulled) a large result set. See per-row comments below.
  cost                  text not null default 'low' check (cost in ('low', 'medium', 'high')),
  load                  text not null default 'eager' check (load in ('eager', 'deferred')),

  is_interactive        boolean not null default false, -- true only for components with write actions (e.g. capacity editor)

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table workspace.component_definitions is
  'Phase 2 component registry — catalogues analytical units that already exist in the app. Read-only for the app today; no page consumes this table yet. See migration 0047 header for scope.';

create trigger set_updated_at
  before update on workspace.component_definitions
  for each row execute function extensions.moddatetime(updated_at);

alter table workspace.component_definitions enable row level security;

create policy component_definitions_read on workspace.component_definitions
  for select
  using (true); -- non-sensitive catalogue metadata, same posture as core.retail_calendar

create policy component_definitions_write on workspace.component_definitions
  for all
  using (core.fn_user_role() = 'super_admin')
  with check (core.fn_user_role() = 'super_admin');

grant select on workspace.component_definitions to authenticated;
grant all on workspace.component_definitions to service_role;

-- -----------------------------------------------------------------------------
-- Seed: every entry below is a component that is LIVE in the app today.
-- Nothing here is invented — cross-reference the file:line cited in each
-- description against the actual page source.
-- -----------------------------------------------------------------------------
insert into workspace.component_definitions
  (id, name, category, description, source_page, requires_page_key,
   supported_metrics, supported_dimensions, supported_comparisons, supported_periods, supported_visuals,
   min_w, min_h, default_w, default_h, cost, load, is_interactive)
values
  ('sales_kpi_grid', 'Sales KPI grid', 'sales',
   'Net sales, discount %, sale bills, units sold, ATV, UPT for the selected date range/store filter. app/(ho)/network/page.tsx SalesSection.',
   'network', 'network',
   array['net_sales','gross_sales','discount_pct','sale_bills','units_sold','atv','upt'], array['store'], array['none'], array['custom'], array['kpi'],
   6, 2, 12, 2, 'low', 'eager', false),

  ('weekly_sales_table', 'Week-wise sales table', 'sales',
   'Per-store (+ network total) weekly net sales and quantity with week-over-week %. app/(ho)/network/page.tsx SalesSection (weekTables).',
   'network', 'network',
   array['net_sales','sale_quantity'], array['store','retail_week'], array['previous_period'], array['custom'], array['table'],
   6, 4, 6, 5, 'low', 'eager', false),

  ('sales_trend_chart', 'Net sales by day (network)', 'sales',
   'Daily net sales line chart across the network for the selected range. app/(ho)/network/page.tsx SalesSection (TrendChart).',
   'network', 'network',
   array['net_sales'], array['date'], array['none'], array['custom'], array['line'],
   6, 3, 6, 4, 'low', 'eager', false),

  ('hourly_sales_chart', 'Net sales by hour of day', 'sales',
   'Bar chart of net sales bucketed by hour-of-day, 9am-midnight. app/(ho)/network/page.tsx SalesSection (HourlyBarChart).',
   'network', 'network',
   array['net_sales'], array['hour_of_day'], array['none'], array['custom'], array['bar'],
   6, 3, 6, 4, 'low', 'eager', false),

  ('store_league_table', 'Store league', 'sales',
   'Per-store net sales, bills, units, ATV, UPT, discount %, ranked by net sales. app/(ho)/network/page.tsx SalesSection (league).',
   'network', 'network',
   array['net_sales','sale_bills','sale_quantity','atv','upt','discount_pct'], array['store'], array['none'], array['custom'], array['table'],
   6, 4, 6, 5, 'low', 'eager', false),

  ('scheme_penetration', 'Scheme penetration (by units sold)', 'sales',
   'Bar breakdown of units sold by scheme group, including NO SCHEME. app/(ho)/network/page.tsx SalesSection (schemeRows).',
   'network', 'network',
   array['sale_quantity','net_sales'], array['scheme_group'], array['none'], array['custom'], array['bar'],
   6, 3, 6, 4, 'low', 'eager', false),

  ('agent_sales_table', 'Agent-wise sales', 'sales',
   'Top 12 agents by net sales — bills, units, net, ATV. app/(ho)/network/page.tsx SalesSection (agentRows).',
   'network', 'network',
   array['sale_bills','sale_quantity','net_sales','atv'], array['agent','store'], array['none'], array['custom'], array['table'],
   6, 4, 6, 5, 'low', 'eager', false),

  ('footfall_kpi_grid', 'Footfall & growth KPI grid', 'footfall',
   'Footfall, conversion %, sales per footfall, WOW growth. app/(ho)/network/page.tsx FootfallSection.',
   'network', 'network',
   array['footfall','conversion_pct','sales_per_footfall','wow_pct'], array['store'], array['previous_period'], array['custom'], array['kpi'],
   6, 2, 8, 2, 'medium', 'eager', false),

  ('footfall_quality_kpi_grid', 'Footfall data quality KPI grid', 'footfall',
   'Non-converting visits, footfall completeness %, missing-today count, stores with traffic issues. app/(ho)/network/page.tsx FootfallSection.',
   'network', 'network',
   array['non_converting_visits','footfall_completeness_pct'], array['store'], array['none'], array['custom'], array['kpi'],
   6, 2, 8, 2, 'medium', 'eager', false),

  ('network_insights_kpi_grid', 'More KPIs (network insights)', 'footfall',
   'Top store, weakest store, scheme penetration %, stores flagged. Duplicates weeks/schemeDaily queries by design — see FootfallSection header comment. app/(ho)/network/page.tsx FootfallSection.',
   'network', 'network',
   array['net_sales','scheme_penetration_pct'], array['store'], array['none'], array['custom'], array['kpi'],
   6, 2, 8, 2, 'medium', 'eager', false),

  ('suggested_actions', 'Suggested actions', 'footfall',
   'Rule-based natural-language insight bullets (WoW down >5%, discount >25% of gross, scheme penetration >60%, top/bottom store gap >40%, top 3 flagged stores). Thresholds are hardcoded in app/(ho)/network/page.tsx FootfallSection, not centrally governed yet — flagged in the Phase 0 audit as JS-side business logic.',
   'network', 'network',
   array[]::text[], array[]::text[], array['none'], array['custom'], array['list'],
   6, 2, 6, 3, 'medium', 'eager', false),

  ('footfall_conversion_matrix', 'Footfall x conversion matrix', 'footfall',
   '4-quadrant grid classifying each store by footfall and conversion trend vs the prior equal-length period, via assess(). app/(ho)/network/page.tsx FootfallSection.',
   'network', 'network',
   array['footfall','conversion_pct'], array['store'], array['previous_period'], array['custom'], array['matrix'],
   8, 4, 12, 5, 'medium', 'eager', false),

  ('traffic_sales_matrix', 'Traffic vs sales matrix', 'footfall',
   '4-quadrant grid classifying each store by footfall vs sales trend vs the prior period. app/(ho)/network/page.tsx FootfallSection.',
   'network', 'network',
   array['footfall','net_sales'], array['store'], array['previous_period'], array['custom'], array['matrix'],
   8, 4, 12, 5, 'medium', 'eager', false),

  ('store_diagnosis_table', 'Store diagnosis & opportunity', 'footfall',
   'Per-store sales/footfall delta, conversion, ₹/visitor, primary issue, estimated combined opportunity, recommendation. app/(ho)/network/page.tsx FootfallSection (storeDiagnosis).',
   'network', 'network',
   array['net_sales','footfall','conversion_pct','opportunity_value'], array['store'], array['previous_period'], array['custom'], array['table'],
   8, 4, 12, 5, 'medium', 'eager', false),

  ('fresh_discounted_tracker', 'Monthly Fresh/Discounted tracker', 'targets',
   'Day-by-day Fresh and Discounted unit targets vs actuals, cumulative, Ach%, MTD deficit heat-mapped, with per-day remarks. Backed by ops.fn_monthly_fresh_disc_tracker (0.495-of-gross split, see Phase 0 business-logic register). app/(ho)/targets/page.tsx TrackerSection.',
   'targets', 'targets',
   array['fresh_qty','discounted_qty','achievement_pct','mtd_deficit_pct'], array['store','gender','category','date'], array['target'], array['mtd'], array['table'],
   8, 5, 12, 6, 'low', 'eager', false),

  ('upload_history_list', 'Uploaded incentive-target files', 'targets',
   'Audit list of incentive-target Excel uploads with status. app/(ho)/targets/page.tsx UploadedFilesSection.',
   'targets', 'targets',
   array[]::text[], array[]::text[], array['none'], array['none'], array['table'],
   4, 3, 6, 4, 'low', 'eager', false),

  ('stock_vs_capacity_table', 'Current stock vs planned display capacity', 'stock',
   'Per-store, per-segment (gender x age) Fresh/EOSS planned capacity vs current stock on hand, with Short/Excess/On-target status. app/(stock-details)/stock-details/page.tsx StockVsCapacityTable.',
   'stock-details', 'stock-details',
   array['closing_stock','planned_capacity'], array['store','gender','age_segment'], array['target'], array['none'], array['table'],
   8, 4, 12, 5, 'high', 'eager', false),

  ('gender_split_card', 'Gender split (planned / current)', 'stock',
   'Girls vs Boys share of planned capacity or current stock, as a two-number card. app/(stock-details)/stock-details/page.tsx GenderSplitCard.',
   'stock-details', 'stock-details',
   array['closing_stock','planned_capacity'], array['gender'], array['none'], array['none'], array['kpi'],
   4, 2, 6, 3, 'medium', 'eager', false),

  ('capacity_editor', 'Planned display capacity editor', 'stock',
   'HO Admin/Super Admin-only form to set base capacity, buffer %, fresh % per store x gender x age-segment. Writes ops.stock_display_capacity. app/(stock-details)/stock-details/capacity-editor.tsx.',
   'stock-details', 'stock-details',
   array['planned_capacity'], array['store','gender','age_segment'], array['none'], array['none'], array['form'],
   6, 4, 6, 5, 'low', 'eager', true),

  ('stock_breakdown_table', 'Stock breakdown (season/size-group/color/size)', 'stock',
   'Fresh/EOSS unit split grouped by a chosen dimension (season, size group, shade, size), top-15 for color. app/(stock-details)/stock-details/page.tsx BreakdownSection.',
   'stock-details', 'stock-details',
   array['closing_stock'], array['season','size_group','color','size'], array['none'], array['none'], array['table'],
   6, 4, 6, 5, 'high', 'eager', false),

  ('replenishment_kpi_grid', 'Replenishment KPI grid', 'replenishment',
   'Style-colors needing replenishment, units required, critical count, stores at risk, warehouse available, transfer/purchase/exhausted counts. app/(replenishment)/replenishment/page.tsx ReplenishmentContent.',
   'replenishment', 'replenishment',
   array['recommended_qty','priority','warehouse_units'], array['store'], array['none'], array['custom'], array['kpi'],
   8, 2, 12, 2, 'high', 'eager', false),

  ('top_supply_moves_table', 'Where should we send stock?', 'replenishment',
   'Top 10 supply moves ranked by priority score, with estimated sales protected. app/(replenishment)/replenishment/page.tsx ReplenishmentContent.',
   'replenishment', 'replenishment',
   array['priority_score','recommended_qty','sales_value_protected'], array['store','style','color'], array['none'], array['custom'], array['table'],
   8, 4, 8, 5, 'high', 'eager', false),

  ('replenishment_recommendations_table', 'Replenishment recommendations', 'replenishment',
   'Full network allocation engine output — priority, score, SOH, daily demand, trend, cover, reorder point, target, recommended qty, action, per-size breakdown. Reads up to 40k stock + 100k sale rows (see lib/replenishment/compute.ts) — the single most expensive component in the registry. app/(replenishment)/replenishment/page.tsx.',
   'replenishment', 'replenishment',
   array['priority_score','soh','daily_demand','cover_days','recommended_qty'], array['store','style','color','size'], array['none'], array['custom'], array['table'],
   12, 6, 12, 8, 'high', 'eager', true),

  ('mix_status_kpi_grid', 'Mix status KPI grid', 'mix',
   'Counts by mix-gap status: high priority, allocation opportunity, balanced, stock heavy, overstocked. app/(replenishment)/sale-stock-mix/page.tsx SaleStockMixContent.',
   'replenishment', 'replenishment',
   array['mix_status_count'], array['store'], array['none'], array['custom'], array['kpi'],
   8, 2, 10, 2, 'high', 'eager', false),

  ('sale_stock_mix_table', 'Sale mix vs stock mix table', 'mix',
   'Per style-color: sale mix %, stock mix %, mix gap (pp), status, recommended action, warehouse-availability check. Reads the same 40k/100k-row queries as replenishment_recommendations_table (separately, by design — see lib/replenishment/mix.ts). app/(replenishment)/sale-stock-mix/page.tsx.',
   'replenishment', 'replenishment',
   array['sale_mix_pct','stock_mix_pct','mix_gap_pts'], array['store','style','color'], array['none'], array['custom'], array['table'],
   10, 5, 12, 6, 'high', 'eager', false)
on conflict (id) do nothing;
