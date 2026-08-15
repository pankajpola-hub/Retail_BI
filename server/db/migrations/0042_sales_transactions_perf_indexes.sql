-- =============================================================================
-- 0042 · Missing indexes on the hot query paths (performance pass)
-- =============================================================================
-- raw_logic.sales_transactions (~23k+ rows and growing with every Sale
-- upload) has had ZERO indexes since it was created in 0004 — every filter/
-- join against it (sales.vw_ebo_sales_lines' join to core.stores on
-- branch_name, every subcategory/gender/scheme lookup join on item_code,
-- every date-scoped query on the Network/Targets pages) has been a full
-- table scan. Invisible at 2 stores / ~23k rows where Postgres's seq-scan
-- default is genuinely fine; won't stay invisible as history/stores grow.
-- raw_logic.scheme_lookup has the same gap on its item_code join.
--
-- Plain btree indexes only — additive, no data/behavior change, safe to run
-- against a live table (CREATE INDEX without CONCURRENTLY takes a brief
-- write lock; acceptable at current table sizes, revisit CONCURRENTLY if
-- this ever needs to run against a much larger live table later).

create index if not exists idx_sales_transactions_branch_name
  on raw_logic.sales_transactions (branch_name);

create index if not exists idx_sales_transactions_item_code
  on raw_logic.sales_transactions (item_code);

-- Composite on (branch_name, bill_date): the two columns almost every
-- consuming view/route filters/groups by together (per-store, date-scoped
-- reporting is the app's single most common query shape). bill_date stays a
-- plain text column (see 0004's header on why — matches the source report's
-- own DD/MM/YYYY text convention), so this speeds up equality/grouping on
-- the raw text; see the functional index below for actual date-range
-- filtering on the parsed value.
create index if not exists idx_sales_transactions_branch_bill_date
  on raw_logic.sales_transactions (branch_name, bill_date);

-- A functional index matching the views' date-parsing expression (to_date()
-- on the DD/MM/YYYY text) was attempted here but rejected by Postgres:
-- to_date() is STABLE, not IMMUTABLE, so it can't back an index at all
-- (SQLSTATE 42P17) without wrapping it in a custom IMMUTABLE function — extra
-- risk (an IMMUTABLE label is a promise to Postgres the function's output
-- never depends on session state; to_date's format-string parsing is safe in
-- practice but Postgres won't take that on faith). Dropped rather than
-- fought — the plain (branch_name, bill_date) composite index above still
-- speeds up equality/grouping on the raw text for every real query pattern
-- in this app; only a true date-RANGE query on the parsed value would want
-- this, and none of the current views do a range filter directly against
-- raw_logic.sales_transactions.bill_date (they filter on the VIEW's already-
-- parsed output instead, which query engines can't index through anyway).

create index if not exists idx_scheme_lookup_item_code
  on raw_logic.scheme_lookup (item_code);
