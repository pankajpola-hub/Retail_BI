-- =============================================================================
-- 0011 · Schema-level grants
-- =============================================================================
-- Table/view GRANTs in earlier files are inert without USAGE on the schema —
-- Postgres checks both. raw_logic deliberately gets none of this.

grant usage on schema core, sales, ops, marketing to authenticated;

grant select on core.stores to authenticated;
grant select on core.retail_calendar to authenticated;

-- Everything else was granted per-object in its own migration file, next to
-- the RLS policy that governs it, so the two are easy to review together.
