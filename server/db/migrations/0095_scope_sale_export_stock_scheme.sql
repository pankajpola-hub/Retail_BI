-- =============================================================================
-- 0095 · C-09 fix — store-scoped views for vw_sale_transactions_export /
--        vw_stock_with_scheme, resolving the product decision 0094 deferred
-- =============================================================================
-- BACKGROUND (see 0094's header, docs/audit/B-api-security.md and
-- docs/audit/C-database.md, both grep "C-09"): sales.vw_sale_transactions_export
-- and sales.vw_stock_with_scheme are `grant select ... to authenticated` with
-- no store/role predicate of their own — every sibling view (vw_ebo_sales_lines,
-- 0092/0094) filters with `s.store_id = any(core.fn_user_store_ids())`, these
-- two don't. Reachable directly over PostgREST by any authenticated JWT,
-- bypassing whatever role/scope check the Next.js route layer does.
--
-- 0094 declined to add that predicate directly because two legitimate callers
-- — Replenishment and Sale-vs-Stock-Mix (both on /movement, web/app/(replenishment)/
-- movement/page.tsx, web/lib/replenishment/compute.ts + mix.ts) — read BOTH
-- views expecting genuinely WHOLE-NETWORK rows: Replenishment computes
-- warehouse->store / store->store transfer recommendations, which requires
-- seeing every OTHER store's stock, not just the caller's own; Mix defaults
-- its store selector to "All stores" and computes sale/stock-mix percentages
-- against network-wide totals by design (mix.ts:452-454's own comment: "storeId
-- = "" means network-wide totals per style-color, not 'all stores' own rows
-- together'"). A blind fn_user_store_ids() predicate on these two views would
-- have silently zeroed those pages out for every non-admin role.
--
-- INVESTIGATION (2026-08-27, traced every consumer — grep sales.vw_sale_
-- transactions_export / sales.vw_stock_with_scheme across web/):
--   1. web/app/api/data-upload/download-merged/route.ts — full merged-sale
--      export, role-gated ho_admin/super_admin only, whole-network BY DESIGN
--      (its own comment already says so). Correctly matched already; untouched.
--   2. web/lib/replenishment/{compute,mix}.ts, via /movement — whole-network
--      BY DESIGN (see above), reachable by ho_admin/regional_manager/
--      super_admin/ebo_manager/marketing (PAGE_ROLE_DEFAULTS.replenishment).
--      Untouched — still needs the unscoped views.
--   3. web/app/(stock-details)/stock-details/page.tsx and
--      web/lib/workspace/renderStockComponents.tsx (both read
--      vw_stock_with_scheme only) — NEITHER needs whole-network data. Both
--      already try to filter to the caller's own scope in JS (stock-details:
--      `.in("branch_name", branchFilter)`; workspace:
--      `.eq("branch_name", ...)` when exactly one store is selected) but
--      neither actually intersects against the caller's own
--      core.fn_user_store_ids() — stock-details' branch dropdown lists every
--      known store regardless of who's asking, and workspace falls through to
--      a completely UNFILTERED `.limit(20000)` fetch whenever the saved
--      workspace filter has 0 or >1 stores selected (renderStockComponents.tsx
--      line ~69-70). Both are real, independent scoping bugs on top of C-09 —
--      moving them onto a store-scoped view fixes both at once, at the only
--      layer that can't be bypassed by a direct PostgREST call.
--
-- FIX: two new views, narrow-scoped for the callers that only need the
-- caller's own stores (#3 above), leaving the original two views untouched
-- for the callers that genuinely need whole-network (#1, #2). This is
-- additive only — no existing view's column list, grants, or behavior for
-- Replenishment/Mix/download-merged changes.
--
--   * sales.vw_stock_with_scheme_scoped — same shape as vw_stock_with_scheme,
--     INNER joined to core.stores (active only) and filtered to
--     `s.store_id = any(core.fn_user_store_ids())`, same pattern as
--     vw_ebo_sales_lines (0092/0094). For ho_admin/super_admin,
--     fn_user_store_ids() already returns every store (core.fn_user_store_ids,
--     0003), so this view is a no-op restriction for admin roles and a real
--     one for store-scoped roles — exactly the behavior stock-details/
--     workspace already intended but didn't enforce.
--   * sales.vw_sale_transactions_export_scoped — same treatment, same join.
--
-- Neither new view is wired up to Replenishment/Mix/download-merged — those
-- keep reading the original unscoped views, which remains correct for them.
--
-- The original two views are NOT locked down further here (e.g. to an
-- admin-only role predicate) because every one of this app's five roles
-- (super_admin, ho_admin, regional_manager, ebo_manager, marketing — the
-- complete AppRole set, web/lib/auth/roles.ts) already has a legitimate,
-- product-intended path to whole-network data through Replenishment/Mix, so a
-- role allowlist on the view would be a no-op. What the unscoped grant DOES
-- still expose beyond that: any authenticated Supabase JWT with no
-- core.profiles row at all (never provisioned, or since deprovisioned) can
-- currently still read both views raw, since `authenticated` covers every
-- valid session token, not just users this app has assigned a role to. Both
-- unscoped views get one more predicate — `core.fn_user_role() is not null`
-- — to close exactly that gap without narrowing anything a real role needs;
-- core.fn_user_role() (0003) reads core.profiles and returns NULL for anyone
-- without a row there.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- sales.vw_stock_with_scheme_scoped — store-scoped copy of vw_stock_with_scheme
-- (0024/0056/0084/0087) for callers that only need the caller's own stores:
-- stock-details and the workspace stock tiles. Column list matches
-- vw_stock_with_scheme exactly (0087's definition); adds store_id for callers
-- that want it without a second core.stores round trip.
-- -----------------------------------------------------------------------------
create or replace view sales.vw_stock_with_scheme_scoped
with (security_invoker = off, security_barrier = true) as
select
  ss.id, ss.branch_name, ss.godown_name, ss.company_name,
  s.store_id,
  coalesce(nullif(trim(im.season), ''), ss.season)                       as season,
  coalesce(nullif(trim(im.market_segment), ''), ss.market_segment)       as market_segment,
  coalesce(nullif(trim(im.gender), ''), nullif(trim(ss.gender), ''))     as gender,
  coalesce(nullif(trim(im.size_group), ''), nullif(trim(ss.size_group), '')) as size_group,
  coalesce(nullif(trim(im.subcategory), ''), ss.subcategory)             as subcategory,
  ss.item_code,
  coalesce(nullif(trim(im.item_name), ''), ss.item_name)                 as item_name,
  coalesce(nullif(trim(im.shade_name), ''), ss.shade_name)               as shade_name,
  coalesce(nullif(trim(im.size), ''), nullif(trim(ss.size), ''))         as size,
  ss.closing_stock, ss.rate,
  sl.scheme_name,
  sl.discount_pct,
  coalesce(sl.is_discounted_50plus, false) as is_eoss,
  im.mrp
from raw_logic.stock_snapshot ss
  join core.stores s on s.branch_name_erp = ss.branch_name and s.is_active
  left join raw_logic.item_master im on im.item_code = ss.item_code
  left join raw_logic.scheme_lookup sl on sl.item_code = ss.item_code
where s.store_id = any (core.fn_user_store_ids());

comment on view sales.vw_stock_with_scheme_scoped is
  'C-09 fix (0095) — store-scoped twin of sales.vw_stock_with_scheme, for callers (stock-details, workspace stock tiles) that only ever need the caller''s own stores, never the whole network. INNER joins core.stores (active only) and filters s.store_id = any(core.fn_user_store_ids()), same pattern as vw_ebo_sales_lines (0092/0094). A no-op restriction for ho_admin/super_admin (fn_user_store_ids() already returns every store for them) and a real one for store-scoped roles. Also drops non-store branches (warehouses) entirely, since neither current caller wants those. Replenishment and Sale-vs-Stock-Mix must keep reading the original sales.vw_stock_with_scheme (they need whole-network rows, including warehouse branches) — do not repoint them at this view.';

grant select on sales.vw_stock_with_scheme_scoped to authenticated;

-- -----------------------------------------------------------------------------
-- sales.vw_sale_transactions_export_scoped — store-scoped copy of
-- vw_sale_transactions_export (0028/0033/0085/0086/0087/0094). Column list
-- matches the 0094 definition exactly (including the C-13 discount_amount
-- COALESCE and 0087's im.size); adds store_id for the same reason as above.
-- -----------------------------------------------------------------------------
create or replace view sales.vw_sale_transactions_export_scoped
with (security_invoker = off, security_barrier = true) as
select
  st.branch_name,
  s.store_name,
  s.store_id,
  case
    when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$' then to_date(st.bill_date, 'DD/MM/YYYY')
    else st.bill_date::date
  end as bill_date,
  st.bill_no,
  case
    when st.bill_no like '%SB-%' then 'SALE'
    when st.bill_no like '%RB-%' then 'RETURN'
    else 'OTHER'
  end as bill_type,
  st.item_code,
  st.total_quantity,
  st.gross_amount,
  st.net_amount,
  st.gross_amount - coalesce(st.net_amount, st.gross_amount) as discount_amount,
  st.agent_name,
  nullif(trim(st.scheme_name), '') as scheme_name,
  nullif(trim(st.scheme_group_name), '') as scheme_group_name,
  st.bill_time,
  st.line_seq,
  case
    when extract(month from (case when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$' then to_date(st.bill_date, 'DD/MM/YYYY') else st.bill_date::date end)) >= 4
      then 'FY' || extract(year from (case when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$' then to_date(st.bill_date, 'DD/MM/YYYY') else st.bill_date::date end))::int || '-' ||
           lpad(((extract(year from (case when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$' then to_date(st.bill_date, 'DD/MM/YYYY') else st.bill_date::date end))::int + 1) % 100)::text, 2, '0')
    else 'FY' || (extract(year from (case when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$' then to_date(st.bill_date, 'DD/MM/YYYY') else st.bill_date::date end))::int - 1) || '-' ||
         lpad((extract(year from (case when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$' then to_date(st.bill_date, 'DD/MM/YYYY') else st.bill_date::date end))::int % 100)::text, 2, '0')
  end as financial_year,
  im.item_name,
  im.shade_name,
  im.season,
  im.market_segment,
  im.gender,
  im.size_group,
  im.mrp,
  im.size
from raw_logic.sales_transactions st
  join core.stores s on s.branch_name_erp = st.branch_name and s.is_active
  left join raw_logic.item_master im on im.item_code = st.item_code
where st.branch_name is not null
  and st.bill_no not in ('BRANCH WISE TOTALS', 'GRAND TOTALS')
  and s.store_id = any (core.fn_user_store_ids());

comment on view sales.vw_sale_transactions_export_scoped is
  'C-09 fix (0095) — store-scoped twin of sales.vw_sale_transactions_export, for callers that only ever need the caller''s own stores. Unlike the original view''s LEFT JOIN to core.stores, this is an INNER JOIN (active only) plus s.store_id = any(core.fn_user_store_ids()), same pattern as vw_ebo_sales_lines (0092/0094) — drops non-store branch_name rows (e.g. warehouse/office channel) entirely, which is correct for every current caller of this scoped view (none want non-retail branches). No current TS caller reads this view yet as of 0095 — added alongside vw_stock_with_scheme_scoped for symmetry and for the next consumer that needs a store-scoped sale export; the two known real consumers of the ORIGINAL unscoped view (Replenishment/Mix on /movement, and the ho_admin/super_admin merged-sale download) both still need whole-network + warehouse rows and must keep reading sales.vw_sale_transactions_export.';

grant select on sales.vw_sale_transactions_export_scoped to authenticated;

-- -----------------------------------------------------------------------------
-- Harden the original two unscoped views: close the one gap a role allowlist
-- can still close given every AppRole already has a legitimate whole-network
-- path (see header) — a signed-in Supabase JWT with no core.profiles row
-- (never provisioned, or since deprovisioned) can currently still read both
-- views raw. core.fn_user_role() (0003) returns NULL for such a caller.
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
  coalesce(nullif(trim(im.size), ''), nullif(trim(ss.size), ''))         as size,
  ss.closing_stock, ss.rate,
  sl.scheme_name,
  sl.discount_pct,
  coalesce(sl.is_discounted_50plus, false) as is_eoss,
  im.mrp
from raw_logic.stock_snapshot ss
left join raw_logic.item_master im on im.item_code = ss.item_code
left join raw_logic.scheme_lookup sl on sl.item_code = ss.item_code
where core.fn_user_role() is not null;

comment on view sales.vw_stock_with_scheme is
  'Stock snapshot rows enriched with scheme/EOSS info (0024), product-attribute fields (0056: item_name, shade_name, season, market_segment, gender, size_group, subcategory), mrp (0084), and size (0087, coalesced from item_master over the stock snapshot''s own size, same pattern as every other attribute here). rate (from stock_snapshot) and mrp (from item_master) are separate fields from separate source tables and are not guaranteed to match. C-09 (0095): stays whole-network/unscoped deliberately — Replenishment and Sale-vs-Stock-Mix (/movement) need every store''s rows, not just the caller''s own (see 0095''s header) — but now requires core.fn_user_role() is not null, so a Supabase JWT with no core.profiles row (never provisioned or since deprovisioned) can no longer read it raw over PostgREST. Callers that only need the caller''s own stores should read sales.vw_stock_with_scheme_scoped instead.';

create or replace view sales.vw_sale_transactions_export
with (security_invoker = off, security_barrier = true) as
select
  st.branch_name,
  s.store_name,
  case
    when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$' then to_date(st.bill_date, 'DD/MM/YYYY')
    else st.bill_date::date
  end as bill_date,
  st.bill_no,
  case
    when st.bill_no like '%SB-%' then 'SALE'
    when st.bill_no like '%RB-%' then 'RETURN'
    else 'OTHER'
  end as bill_type,
  st.item_code,
  st.total_quantity,
  st.gross_amount,
  st.net_amount,
  st.gross_amount - coalesce(st.net_amount, st.gross_amount) as discount_amount,
  st.agent_name,
  nullif(trim(st.scheme_name), '') as scheme_name,
  nullif(trim(st.scheme_group_name), '') as scheme_group_name,
  st.bill_time,
  st.line_seq,
  case
    when extract(month from (case when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$' then to_date(st.bill_date, 'DD/MM/YYYY') else st.bill_date::date end)) >= 4
      then 'FY' || extract(year from (case when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$' then to_date(st.bill_date, 'DD/MM/YYYY') else st.bill_date::date end))::int || '-' ||
           lpad(((extract(year from (case when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$' then to_date(st.bill_date, 'DD/MM/YYYY') else st.bill_date::date end))::int + 1) % 100)::text, 2, '0')
    else 'FY' || (extract(year from (case when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$' then to_date(st.bill_date, 'DD/MM/YYYY') else st.bill_date::date end))::int - 1) || '-' ||
         lpad((extract(year from (case when st.bill_date ~ '^\d{2}/\d{2}/\d{4}$' then to_date(st.bill_date, 'DD/MM/YYYY') else st.bill_date::date end))::int % 100)::text, 2, '0')
  end as financial_year,
  im.item_name,
  im.shade_name,
  im.season,
  im.market_segment,
  im.gender,
  im.size_group,
  im.mrp,
  im.size
from raw_logic.sales_transactions st
  left join core.stores s on s.branch_name_erp = st.branch_name
  left join raw_logic.item_master im on im.item_code = st.item_code
where st.branch_name is not null
  and st.bill_no not in ('BRANCH WISE TOTALS', 'GRAND TOTALS')
  and core.fn_user_role() is not null;

comment on view sales.vw_sale_transactions_export is
  'Unscoped (admin-only, gated at the route layer) full export of raw_logic.sales_transactions. discount_amount COALESCEs net_amount to gross_amount (0094/C-13), matching vw_ebo_sales_lines, so a NULL net_amount row shows 0 discount instead of NULL. C-09 (0095): stays whole-network/unscoped deliberately — Replenishment and Sale-vs-Stock-Mix (/movement) need every store''s rows (see 0095''s header) — but now requires core.fn_user_role() is not null, so a Supabase JWT with no core.profiles row (never provisioned or since deprovisioned) can no longer read it raw over PostgREST. Callers that only need the caller''s own stores should read sales.vw_sale_transactions_export_scoped instead.';

-- Grants unchanged for the two original views (already `authenticated` from
-- 0087) — CREATE OR REPLACE VIEW does not reset existing grants, but restated
-- here for clarity/auditability, matching 0094's own convention.
grant select on sales.vw_stock_with_scheme to authenticated;
grant select on sales.vw_sale_transactions_export to authenticated;

notify pgrst, 'reload schema';
