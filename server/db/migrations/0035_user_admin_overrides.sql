-- =============================================================================
-- 0035 · Per-user page-access overrides
-- =============================================================================
-- Backing table for two admin-only Users page features (user feedback #15/#16):
--   - renaming a user (core.profiles.full_name + Keycloak firstName/lastName —
--     no schema change needed there, that column already exists)
--   - store allocation (core.user_store_access — already exists since 0003,
--     just needed an admin UI to edit it after invite time; no schema change)
--   - per-user page/menu rights, which DOES need a new table: role-based
--     defaults (TopNav's NAV_LINKS, each route group's access gate) stay the
--     baseline, and this table holds explicit per-user exceptions on top —
--     "this user, despite their role, should/shouldn't see page Y".
--
-- One row per (user, page) the admin has explicitly overridden. No row means
-- "defer to the role default" — this table is exceptions-only, not a mirror
-- of every user's full access list. allowed=false revokes a page the role
-- would normally see; allowed=true grants a page the role normally
-- wouldn't. page_key is a free-text label (not an enum) matching the
-- PageKey union in lib/auth/roles.ts (network, stock-details, footfall,
-- targets, users, integrations, data-upload) — kept as text rather than a
-- DB enum so adding a new gated page doesn't require a migration.
create table core.user_page_overrides (
  user_id    uuid not null references core.profiles (user_id) on delete cascade,
  page_key   text not null,
  allowed    boolean not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, page_key)
);

comment on table core.user_page_overrides is
  'Per-user exception on top of the role-based page-access default. Absence of a row for (user_id, page_key) means "use the role default" — see PAGE_ROLE_DEFAULTS in web/lib/auth/roles.ts and NAV_LINKS in web/components/ui/TopNav.tsx. Written only by super_admin via the service-role client (app/(admin)/users/actions.ts), same as core.user_store_access.';

alter table core.user_page_overrides enable row level security;

-- Same read pattern as core.user_store_access: a user can read their own
-- overrides (requirePageAccess() in roles.ts needs this to enforce the
-- override for the caller's own session), and super_admin/ho_admin can read
-- everyone's (Users page admin UI). No authenticated-role write policy —
-- writes go through the service-role client only, same as user_store_access.
create policy user_page_overrides_self_read on core.user_page_overrides
  -- core.current_user_id() (0003) reads app.user_id, the session var
  -- PostgREST's authenticator sets per-request from the caller's Keycloak
  -- JWT (core.fn_postgrest_pre_request) — this project is self-hosted in
  -- production (DATA_BACKEND=selfhosted, confirmed live), not Supabase, so
  -- there is no auth.uid()/auth schema at all on this database. Same
  -- function core.fn_user_role() already calls internally, just used here
  -- directly instead of through that wrapper.
  for select using (user_id = core.current_user_id() or core.fn_user_role() in ('super_admin', 'ho_admin'));

-- RLS policies only filter rows — the role still needs the base table-level
-- privilege before the policy above ever gets evaluated, same as
-- core.user_store_access's own `grant select ... to authenticated`. No
-- INSERT/UPDATE/DELETE grant here on purpose: writes go through the
-- service-role client only, per the header comment.
grant select on core.user_page_overrides to authenticated;
