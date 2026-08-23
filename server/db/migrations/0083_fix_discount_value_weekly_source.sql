-- =============================================================================
-- 0083 · Fix a silently-missed weekly source seeded by 0082.
-- =============================================================================
-- 0082 seeded second-grain (weekly) homes for the metrics that genuinely live
-- at both daily and weekly grain. One of the eight never landed.
--
-- The seed keyed on metric_id and listed ('discount', 'discount') — but the
-- metric's id is `discount_value`; only its COLUMN is named `discount`. The
-- INSERT joined workspace.metric_definitions on m.id = 'discount', matched no
-- row, and contributed nothing. `on conflict do nothing` meant no error was
-- raised, so the gap was invisible: 0082 reported success having seeded 7 of
-- the 8 intended rows.
--
-- Found by scripts/verify-metrics.mjs, which refused to verify discount_value
-- with "no weekly-grain source catalogued (homes: daily)". That is exactly the
-- job cross-derivation verification exists to do — an id/column mismatch is
-- invisible to review and to the database, but not to a check that asks the
-- catalogue to prove itself against real numbers.
--
-- Behaviour impact of the gap: none yet. Nothing reads metric_sources for
-- weekly rollup at the time of writing, so this corrects the catalogue before
-- anything depends on it rather than fixing a live wrong number.

insert into workspace.metric_sources (metric_id, grain, source_view, source_column, is_default, provenance)
values (
  'discount_value',
  'weekly',
  'sales.vw_ebo_sales_weekly',
  'discount',
  false,
  'Same measure at weekly grain. Missed by 0082 because that migration keyed the seed on the COLUMN name (discount) instead of the METRIC id (discount_value); caught by scripts/verify-metrics.mjs.'
)
on conflict (metric_id, grain) do nothing;

notify pgrst, 'reload schema';
