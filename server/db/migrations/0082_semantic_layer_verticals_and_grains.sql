-- =============================================================================
-- 0082 · Semantic layer, Phase 1 of the unified Sales explore:
--        vertical as a dimension, the Ecomm catalogue, and multi-grain metrics.
-- =============================================================================
-- WHY: the plan is one Sales page where a user picks vertical / store /
-- channel / any attribute and chooses their own fields. Three things block
-- that today, and all three are in the semantic layer rather than the UI:
--
--   1. There is no `vertical` dimension, so "show me ECOM" is not expressible
--      in the governed vocabulary at all — only as an ad-hoc searchParam.
--   2. Ecomm is absent: zero of the 34 metrics reference any sales.vw_ecomm_*
--      view. "Any vertical" cannot work until it exists here.
--   3. A metric carries exactly ONE source_view, so a metric that genuinely
--      exists at two grains (net_sales lives on BOTH vw_ebo_sales_daily and
--      vw_ebo_sales_weekly) can only be catalogued at one. Objective.md calls
--      this "the next real Phase 4 design step", and it is why
--      renderSalesComponents.tsx currently THROWS rather than render a
--      weekly-backed number next to a daily-filtered one.
--
-- Nothing user-visible changes here. This migration only widens the
-- vocabulary; the pages still read their hand-written queries.
--
-- NOTE ON is_verified: every existing row is false, and this migration does
-- NOT flip any of them. Verification is earned by a parity check proving a
-- metric reproduces the number its live page shows — that is a separate,
-- evidence-producing step, not something a migration may assert.

-- -----------------------------------------------------------------------------
-- 1. Multi-grain metric sources.
--
--    A separate table rather than more columns on metric_definitions: a metric
--    has ONE meaning (label, unit, decimals, provenance) and potentially
--    SEVERAL physical homes. Flattening those into metric_definitions would
--    duplicate the meaning per grain and let the copies drift, which is
--    exactly what the semantic layer exists to prevent.
--
--    metric_definitions.source_view/source_column are deliberately LEFT IN
--    PLACE and still populated — every current reader (semantic.ts,
--    queryPlanner.ts, the render* modules) keeps working untouched. This table
--    is additive; the planner learns to prefer it in a later step.
-- -----------------------------------------------------------------------------
create table workspace.metric_sources (
  metric_id     text not null references workspace.metric_definitions (id) on delete cascade,
  -- 'daily' | 'weekly' | 'hourly' | 'monthly' | 'line' — free text, same
  -- reasoning as app_settings.key and user_page_overrides.page_key: a new
  -- grain should never require a migration.
  grain         text not null,
  source_view   text not null,
  source_column text not null,
  -- Exactly one row per metric is the default: the grain a caller gets when
  -- it doesn't ask for one. Enforced by the partial unique index below.
  is_default    boolean not null default false,
  provenance    text not null,
  primary key (metric_id, grain)
);

create unique index metric_sources_one_default_per_metric
  on workspace.metric_sources (metric_id) where is_default;

comment on table workspace.metric_sources is
  'Physical homes of a metric, one row per grain. A metric that exists at several grains (net_sales at daily AND weekly) is catalogued once in metric_definitions and once per grain here. Solves the single-source_view limitation that makes weekly-backed components unable to honour a daily-grain filter — see renderSalesComponents.tsx, which throws rather than render an unfiltered number beside a filtered one.';

-- Backfill: every existing view_column metric keeps its current home as the
-- default grain, so nothing regresses. Grain is inferred from the view name,
-- which is unambiguous for every view currently catalogued.
insert into workspace.metric_sources (metric_id, grain, source_view, source_column, is_default, provenance)
select
  id,
  case
    when source_view like '%_weekly' then 'weekly'
    when source_view like '%_hourly' then 'hourly'
    when source_view like '%_daily'  then 'daily'
    -- Named explicitly rather than falling through to a catch-all: a grain
    -- label that says nothing ('other') is a trap for whoever later asks
    -- "can this metric be rolled up with that one".
    when source_view = 'ops.vw_ebo_target_achievement' then 'monthly'
    when source_view = 'marketing.vw_campaign_metrics' then 'campaign'
    else 'unclassified'
  end,
  source_view,
  source_column,
  true,
  'Backfilled from metric_definitions.source_view by 0082 — the metric''s pre-existing single home.'
from workspace.metric_definitions
where source_kind = 'view_column' and source_view is not null and source_column is not null;

-- The metrics that genuinely exist at a SECOND grain. These are the pairs that
-- currently force renderSalesComponents.tsx's tripwire: catalogued at daily,
-- but the KPI grid / store league / week series read the weekly view.
-- Column names verified against sales.vw_ebo_sales_weekly's actual columns.
insert into workspace.metric_sources (metric_id, grain, source_view, source_column, is_default, provenance)
select m.id, 'weekly', 'sales.vw_ebo_sales_weekly', w.col, false,
       'Same measure at weekly grain — vw_ebo_sales_weekly is what the Network KPI grid, store league and week series actually read.'
from (values
  ('net_sales',     'net_sales'),
  ('gross_sales',   'gross_sales'),
  ('discount',      'discount'),
  ('sale_bills',    'sale_bills'),
  ('sale_quantity', 'sale_quantity'),
  ('atv',           'atv'),
  ('upt',           'upt'),
  ('discount_pct',  'discount_pct')
) as w(metric_id, col)
join workspace.metric_definitions m on m.id = w.metric_id
on conflict (metric_id, grain) do nothing;

-- -----------------------------------------------------------------------------
-- 2. `vertical` as a first-class dimension.
--
--    Deliberately source_kind 'lookup' with a NULL source_view: unlike store
--    or channel, vertical is not a column on any fact view — it is a property
--    of WHICH view you read (vw_ebo_* is EBO, vw_ecomm_* is ECOM). The planner
--    must therefore resolve it by choosing a source, not by adding a WHERE
--    clause, and a NULL source_view is what stops it being mistaken for a
--    filterable column and silently dropped.
--
--    Vocabulary matches lib/scope/resolveViewScope.ts exactly (ebo/ecomm/
--    mbo/lfs) so one concept governs the business-unit gate, the ScopeBar and
--    the planner rather than three parallel spellings.
-- -----------------------------------------------------------------------------
insert into workspace.dimension_definitions (id, label, description, source_kind, source_view, source_column, provenance) values
  ('vertical', 'Vertical',
   'Which business a figure belongs to: EBO (own stores), ECOM (marketplaces/D2C), MBO or LFS. Not a column on any fact view — it determines which view is read, so the planner resolves it by choosing a source rather than by filtering.',
   'lookup', null, null,
   'Vocabulary mirrors lib/scope/resolveViewScope.ts (ebo/ecomm/mbo/lfs). MBO and LFS have no data pipeline yet (pipelineConnected: false there) — they are valid values with no rows behind them.'),
  ('channel', 'Channel',
   'Ecomm sales channel — Myntra, Ajio, own D2C storefront, etc. The ECOM analogue of `store`: the axis its revenue splits along.',
   'view_column', 'sales.vw_ecomm_daily', 'channel',
   'sales.vw_ecomm_daily.channel (0067). Same column exists on vw_ecomm_order_lines and vw_ecomm_returns.'),
  ('item_sku', 'SKU',
   'Ecomm item SKU at order-line grain.',
   'view_column', 'sales.vw_ecomm_order_lines', 'item_sku',
   'sales.vw_ecomm_order_lines.item_sku (0067) — line grain, and only orders past Uniware item-enrichment appear at all.'),
  ('return_status', 'Return status',
   'Status of an ecomm return, as reported by Uniware.',
   'view_column', 'sales.vw_ecomm_returns', 'status',
   'sales.vw_ecomm_returns.status (0070). Carries 0069''s UNVERIFIED-field-name caveat — values are shown as-is, not mapped to a confirmed workflow.')
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- 3. Ecomm metrics.
--
--    Catalogued but NOT verified (is_verified stays false, as for every other
--    metric today) — verification means a parity check against /ecomm, which
--    is a separate step.
--
--    The unit/decimals conventions match the existing EBO rows so a picker can
--    format ECOM and EBO figures identically.
-- -----------------------------------------------------------------------------
insert into workspace.metric_definitions
  (id, label, description, unit, decimals, source_kind, source_view, source_column, source_expression,
   rollup_strategy, requires_metrics, provenance, verified_against, is_verified)
values
  ('ecomm_orders', 'Orders', 'Ecomm orders placed, including those later cancelled.', 'count', 0,
   'view_column', 'sales.vw_ecomm_daily', 'total_orders', null, null, '{}',
   'sales.vw_ecomm_daily.total_orders (0067). Order counts are always complete, unlike revenue — see revenue_incomplete.', null, false),

  ('ecomm_cancelled_orders', 'Cancelled orders', 'Ecomm orders cancelled.', 'count', 0,
   'view_column', 'sales.vw_ecomm_daily', 'cancelled_orders', null, null, '{}',
   'sales.vw_ecomm_daily.cancelled_orders (0067).', null, false),

  ('ecomm_units', 'Units', 'Ecomm units ordered.', 'count', 0,
   'view_column', 'sales.vw_ecomm_daily', 'units', null, null, '{}',
   'sales.vw_ecomm_daily.units (0067).', null, false),

  ('ecomm_net_selling_value', 'Net selling value', 'Ecomm revenue excluding cancelled lines. A FLOOR, not final, until Uniware item-enrichment catches up (revenue_incomplete).', 'currency_inr', 0,
   'view_column', 'sales.vw_ecomm_daily', 'net_selling_value', null, null, '{}',
   'sales.vw_ecomm_daily.net_selling_value (0067), summed in app/(ecomm)/ecomm/page.tsx.', null, false),

  ('ecomm_gross_mrp_value', 'MRP value', 'Ecomm gross value at MRP, before discount.', 'currency_inr', 0,
   'view_column', 'sales.vw_ecomm_daily', 'gross_mrp_value', null, null, '{}',
   'sales.vw_ecomm_daily.gross_mrp_value (0067).', null, false),

  ('ecomm_discount_value', 'Discount given', 'Ecomm discount value (MRP minus selling).', 'currency_inr', 0,
   'view_column', 'sales.vw_ecomm_daily', 'discount_value', null, null, '{}',
   'sales.vw_ecomm_daily.discount_value (0067).', null, false),

  -- Ratio: MUST be re-derived from its components when rolled up, never
  -- summed or averaged. rollup_strategy + requires_metrics is exactly the
  -- machinery metric_definitions already carries for this.
  ('ecomm_discount_pct', 'Discount %', 'Ecomm discount as a share of MRP value. Re-derive from discount and MRP when rolling up — averaging daily percentages is wrong.', 'percent', 1,
   'view_column', 'sales.vw_ecomm_daily', 'discount_pct', null,
   'ratio_of_sums', '{ecomm_discount_value,ecomm_gross_mrp_value}',
   'app/(ecomm)/ecomm/page.tsx computes 100 * discount_value / gross_mrp_value across the range rather than averaging the per-day discount_pct column.', null, false),

  ('ecomm_returns', 'Returns', 'Ecomm returns raised in the period, counted at reverse-pickup grain.', 'count', 0,
   'view_column', 'sales.vw_ecomm_returns', 'reverse_pickup_code', null, null, '{}',
   'sales.vw_ecomm_returns (0070), counted as rows in app/(ecomm)/ecomm/page.tsx. Filtered on return_date, not updated_on.', null, false)
on conflict (id) do nothing;

-- Ecomm metrics live at daily grain (returns at their own grain).
insert into workspace.metric_sources (metric_id, grain, source_view, source_column, is_default, provenance)
select id, case when source_view = 'sales.vw_ecomm_returns' then 'return' else 'daily' end,
       source_view, source_column, true,
       'Seeded with the metric by 0082.'
from workspace.metric_definitions
where id like 'ecomm\_%' and source_kind = 'view_column'
on conflict (metric_id, grain) do nothing;

-- -----------------------------------------------------------------------------
-- RLS — same shape as the rest of the semantic layer (0048): readable by any
-- signed-in user (it is a catalogue of definitions, not data), written only
-- via migrations / the service-role client.
-- -----------------------------------------------------------------------------
alter table workspace.metric_sources enable row level security;

create policy metric_sources_read on workspace.metric_sources
  for select using (true);

grant select on workspace.metric_sources to authenticated;
grant all on workspace.metric_sources to service_role;

notify pgrst, 'reload schema';
