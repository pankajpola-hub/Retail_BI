-- =============================================================================
-- 0073 · Fix: service-role (admin-client, no end-user session) queries
--        against sales.* return nothing — two separate, stacked causes.
-- =============================================================================
-- Discovered while building threshold alerts (0072): the FIRST ever
-- service-role query against `sales.*` (lib/alerts/runDueAlerts.ts, and
-- lib/exports/scheduledExports.ts's footfall_completeness export, already
-- shipped) hit this. Two independent bugs, both fixed here:
--
-- 1. `service_role` was never granted USAGE on schema `sales` or SELECT on
--    any view in it — every sales.* view's creating migration only ever
--    granted `authenticated` (e.g. 0067's `grant select on
--    sales.vw_ecomm_daily to authenticated`). Confirmed live: querying
--    sales.vw_ebo_sales_weekly as service_role returned
--    "permission denied for schema sales" (42501), before the view's own
--    logic even ran.
--
-- 2. Even with that granted, the view chain
--    vw_ebo_sales_lines -> vw_ebo_bill -> vw_ebo_sales_daily ->
--    vw_ebo_sales_weekly bakes `store_id = ANY(core.fn_user_store_ids())`
--    into the view body at multiple levels — not real Postgres RLS, a
--    literal WHERE clause. core.fn_user_store_ids() (0003) resolves off
--    core.current_user_id() = auth.uid(), which reads the request JWT's
--    `sub` claim. A service-role JWT has no `sub` (it isn't tied to any
--    user), so auth.uid() is null there — fn_user_store_ids()'s ELSE
--    branch then does `... where user_id = null`, which returns NULL (not
--    an empty array), and `store_id = ANY(NULL)` filters out every row.
--    Confirmed live via `set role service_role; select current_user` — the
--    Postgres role IS reliably 'service_role' for these connections
--    (PostgREST SET ROLEs per the JWT's `role` claim), so branching on it
--    is safe and doesn't depend on parsing anything from the JWT.
--
--    Fixed by special-casing service_role to "every store" — the same
--    answer super_admin/ho_admin already get, and consistent with this
--    app's existing trust model (service_role already bypasses RLS
--    everywhere else; lib/data/admin.ts's own header documents this).
--    Every caller of this admin path already re-scopes explicitly in
--    application code afterward (resolveOwnerStoreIds ->
--    .in("store_id", storeIds)), so this doesn't widen what actually gets
--    returned to any caller — it only unblocks the function from
--    returning nothing at all.
--
--    First attempt used `current_user = 'service_role'` — wrong, and
--    confirmed wrong live: this function is SECURITY DEFINER, so
--    current_user INSIDE its body is the function's OWNER (postgres), not
--    the caller, regardless of what role the caller actually connected/
--    switched as. The correct, caller-reflecting signal is the JWT claims
--    GUC PostgREST sets per-request (`request.jwt.claims`) — a session GUC,
--    not tied to the current role, so it survives entering a SECURITY
--    DEFINER function correctly. `current_setting(..., true)` (missing_ok)
--    returns NULL rather than erroring for a connection with no JWT context
--    at all (e.g. a raw psql session), which safely falls through to the
--    next branch below.
--
-- core.fn_user_business_units() has the identical shape and would hit the
-- same wall the moment an admin-context caller queries an ecomm-gated
-- sales.* view — not fixed here (nothing currently calls it that way), but
-- flagged: apply the same current_user = 'service_role' special-case to it
-- first if that need ever arises, rather than rediscovering this.
-- =============================================================================

grant usage on schema sales to service_role;
grant select on all tables in schema sales to service_role;
alter default privileges in schema sales grant select on tables to service_role;

-- core.retail_calendar — a second, narrower instance of the same gap:
-- vw_ebo_sales_daily's spine CTE joins core.stores to this table, which
-- (unlike every other core.* table an admin-context query already touched
-- — stores/profiles/user_store_access/user_business_units, all already
-- granted piecemeal over this project's history) had never been granted to
-- service_role, since nothing admin-context needed it before. Confirmed
-- live: "permission denied for table retail_calendar" from a service-role
-- query, after the sales-schema grants above already fixed the first wall.
grant select on core.retail_calendar to service_role;

create or replace function core.fn_user_store_ids()
returns text[]
language sql
stable security definer
set search_path to 'core', 'pg_temp'
as $function$
  select case
    when coalesce(current_setting('request.jwt.claims', true)::json ->> 'role', '') = 'service_role'
      then (select array_agg(store_id) from core.stores)
    when (select role from core.profiles where user_id = core.current_user_id()) in ('super_admin', 'ho_admin')
      then (select array_agg(store_id) from core.stores)
    else
      (select array_agg(store_id) from core.user_store_access where user_id = core.current_user_id())
  end;
$function$;

notify pgrst, 'reload schema';
