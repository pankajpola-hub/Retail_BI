-- =============================================================================
-- 0079 · Permission system — user lifecycle, runtime-editable role defaults,
--        feature-level permission keys, and an admin audit trail.
-- =============================================================================
-- WHY: permission truth currently lives in three places, none of them
-- editable without a deploy:
--   1. PAGE_ROLE_DEFAULTS  — a hardcoded TS map in lib/auth/roles.ts
--   2. core.app_role       — a Postgres enum
--   3. Permit.io          — a mirrored copy, fail-open
-- lib/auth/roles.ts's own comment admits it: "there isn't a single source of
-- truth for this today". This migration moves (1) into Postgres so the admin
-- UI can actually change it, and widens the model from page-level to
-- feature-level. Permit.io stays FROZEN at page level (it has no deny
-- primitive — see lib/permit/client.ts — so extending it to features would
-- mean a synthesized role per user with an ~80-entry permission list).
--
-- ONE KEY SPACE. A page is just a permission key with no feature segment,
-- so pages and features share one table, one resolver, one UI:
--     network.view                 <- the page itself   (is_page = true)
--     network.agent_sales.view     <- a feature on it
--     targets.bulk_upload.edit
--     users.password.admin
-- Hierarchy falls out of the prefix for free: a deny on `network.view`
-- cascades to everything under `network.`.
--
-- PRECEDENCE (implemented in lib/auth/access.ts, stated here so the schema
-- and the code can't drift):
--   1. business unit gate (PAGE_BUSINESS_UNIT)      — unchanged, in TS
--   2. profiles.status = 'disabled'                 -> deny everything
--   3. exact-key row in user_permission_overrides   -> wins
--   4. a DENY override on any ancestor key          -> cascades down
--   5. role_permissions for the caller's role
--   6. otherwise deny
-- Rule of thumb: a deny on a parent always beats an allow on a child.
--
-- NOTE ON THE SECURITY BOUNDARY: feature gates are VIEW TAILORING, not a new
-- security boundary. RLS + core.fn_user_store_ids() remains the real one and
-- is untouched here. A wrong feature toggle means someone sees a table they
-- didn't need — never another store's data.
--
-- core.user_page_overrides is deliberately NOT dropped: its rows are copied
-- into the new table below and the old one is kept for one release so a
-- rollback stays possible. Drop it in a later migration once this is proven.

-- -----------------------------------------------------------------------------
-- 1. User lifecycle. Closes a real hole: there was previously NO way to
--    revoke a departing employee's access — users/actions.ts exports six
--    actions and none of them deactivate. Stripping stores/business units
--    locked someone out of DATA but left the login working.
-- -----------------------------------------------------------------------------
alter table core.profiles
  add column if not exists status text not null default 'active'
    check (status in ('active', 'disabled'));

alter table core.profiles
  add column if not exists last_active_at timestamptz;

comment on column core.profiles.status is
  'disabled = retained for audit/history but denied everything. See setUserStatus() in users/actions.ts, which also revokes the Supabase session so it takes effect immediately rather than at next token refresh.';

-- -----------------------------------------------------------------------------
-- 2. Role -> permission defaults. This is PAGE_ROLE_DEFAULTS moved out of
--    TypeScript. Seeded below to reproduce today's access EXACTLY, so this
--    migration is behaviour-neutral on day one.
-- -----------------------------------------------------------------------------
create table core.role_permissions (
  role            core.app_role not null,
  permission_key  text not null,
  primary key (role, permission_key)
);

-- -----------------------------------------------------------------------------
-- 3. The permission-key registry. Drives the admin UI.
--
--    `enforced` is the honesty switch: a key may exist here before its
--    server-side gate is wired, but the admin UI renders ONLY enforced keys.
--    A toggle whose gate doesn't exist yet is a lie admins would trust.
--
--    The key's last segment is always its action_class (CHECK below), so the
--    UI can offer a second lens — "show me everything that exports" — instead
--    of forcing admins to hunt page by page.
-- -----------------------------------------------------------------------------
create table core.feature_keys (
  key           text primary key,
  page_key      text not null,
  label         text not null,
  action_class  text not null check (action_class in ('view', 'edit', 'export', 'admin')),
  is_page       boolean not null default false,
  enforced      boolean not null default false,
  sort_order    integer not null default 0,
  -- Integrity: 'network.agent_sales.view' must carry action_class 'view'.
  -- Keeps the key readable and the class trustworthy for filtering.
  constraint feature_keys_suffix_matches_class check (key like '%.' || action_class)
);

create index idx_feature_keys_page on core.feature_keys (page_key, sort_order);

-- -----------------------------------------------------------------------------
-- 4. Per-user exceptions. Supersedes core.user_page_overrides.
-- -----------------------------------------------------------------------------
create table core.user_permission_overrides (
  user_id         uuid not null references core.profiles(user_id) on delete cascade,
  permission_key  text not null,
  allowed         boolean not null,
  updated_at      timestamptz not null default now(),
  primary key (user_id, permission_key)
);

create index idx_user_permission_overrides_user on core.user_permission_overrides (user_id);

-- -----------------------------------------------------------------------------
-- 5. Admin audit trail. Append-only: no update/delete grant to ANY role,
--    including service_role, so history can't be quietly rewritten. Inserts
--    come from the server actions via the admin client.
--
--    actor_name / target_user_name are DENORMALISED on purpose — the log must
--    stay readable after a profile is renamed or deleted, and a join that
--    silently returns null defeats the point of an audit trail.
-- -----------------------------------------------------------------------------
create table core.admin_audit_log (
  id                bigserial primary key,
  actor_id          uuid not null,
  actor_name        text not null,
  action            text not null,
  target_user_id    uuid,
  target_user_name  text,
  detail            jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);

create index idx_admin_audit_log_created on core.admin_audit_log (created_at desc);
create index idx_admin_audit_log_target on core.admin_audit_log (target_user_id, created_at desc);

comment on table core.admin_audit_log is
  'Append-only. No update/delete grants anywhere by design. action is a stable key (role.change, status.change, permissions.change, user.create, user.rename, stores.change, business_units.change, password.reset); the UI renders a readable label on top of it.';

-- =============================================================================
-- SEED
-- =============================================================================

-- 5a. Page-level keys. enforced = true: requirePageAccess() already gates
--     every one of these today, so they are genuinely enforced from day one.
--     NOTE 'replenishment' is the page_key for the /movement route (the route
--     was renamed, the key was not — see HREF_PAGE_KEY in AppShell.tsx).
insert into core.feature_keys (key, page_key, label, action_class, is_page, enforced, sort_order) values
  ('network.view',         'network',        'Network',        'view', true, true, 10),
  ('stock-details.view',   'stock-details',  'Stock Details',  'view', true, true, 20),
  ('replenishment.view',   'replenishment',  'Movement',       'view', true, true, 30),
  ('footfall.view',        'footfall',       'Footfall',       'view', true, true, 40),
  ('targets.view',         'targets',        'Targets',        'view', true, true, 50),
  ('workspace.view',       'workspace',      'Workspace',      'view', true, true, 60),
  ('ecomm.view',           'ecomm',          'Ecomm',          'view', true, true, 70),
  ('users.view',           'users',          'Users',          'view', true, true, 80),
  ('integrations.view',    'integrations',   'Integrations',   'view', true, true, 90),
  ('data-upload.view',     'data-upload',    'Data Upload',    'view', true, true, 100),
  ('configurations.view',  'configurations', 'Configurations', 'view', true, true, 110);

-- 5b. Feature keys. All enforced = false — each flips to true in a later
--     migration ONLY when its server-side gate actually lands. Network and
--     Movement go first (they have the most separable tables).
insert into core.feature_keys (key, page_key, label, action_class, sort_order) values
  -- Network
  ('network.vertical_rollup.view',       'network', 'Vertical rollup KPIs',        'view',   11),
  ('network.exceptions.view',            'network', 'Needs attention list',        'view',   12),
  ('network.alert_subscription.edit',    'network', 'Email digest subscription',   'edit',   13),
  ('network.week_wise_sales.view',       'network', 'Week-wise sales tables',      'view',   14),
  ('network.store_league.view',          'network', 'Store league',                'view',   15),
  ('network.scheme_penetration.view',    'network', 'Scheme penetration',          'view',   16),
  ('network.agent_sales.view',           'network', 'Agent-wise sales',            'view',   17),
  ('network.footfall_matrix.view',       'network', 'Footfall x conversion matrix','view',   18),
  ('network.traffic_sales_matrix.view',  'network', 'Traffic vs sales matrix',     'view',   19),
  ('network.store_diagnosis.view',       'network', 'Store diagnosis & opportunity','view',  20),

  -- Movement (page_key 'replenishment')
  ('replenishment.recommendations.view', 'replenishment', 'Replenishment recommendations', 'view',   31),
  ('replenishment.mix.view',             'replenishment', 'Sale vs Stock Mix',             'view',   32),
  ('replenishment.whatif.edit',          'replenishment', 'What-if assumptions & weights', 'edit',   33),
  ('replenishment.recommendations.export','replenishment','Download recommendations',      'export', 34),

  -- Stock Details
  ('stock-details.capacity.edit',        'stock-details', 'Edit display capacity',         'edit',   21),
  ('stock-details.stock.export',         'stock-details', 'Export stock data',             'export', 22),

  -- Targets
  ('targets.tracker.view',               'targets', 'Daily target tracker',       'view',   51),
  ('targets.monthly_targets.edit',       'targets', 'Set monthly targets',        'edit',   52),
  ('targets.bulk_upload.edit',           'targets', 'Bulk target upload',         'edit',   53),
  ('targets.incentive_upload.edit',      'targets', 'Incentive upload',           'edit',   54),
  ('targets.remarks.edit',               'targets', 'Daily remarks',              'edit',   55),
  ('targets.audit_report.export',        'targets', 'Targets audit report',       'export', 56),

  -- Workspace
  ('workspace.share.edit',               'workspace', 'Share a workspace',        'edit',   61),

  -- Ecomm
  ('ecomm.orders.export',                'ecomm', 'Export ecomm orders',          'export', 71),

  -- Users (admin actions)
  ('users.invite.admin',                 'users', 'Invite a user',                'admin',  81),
  ('users.role.admin',                   'users', 'Change a user role',           'admin',  82),
  ('users.status.admin',                 'users', 'Enable / disable a user',      'admin',  83),
  ('users.password.admin',               'users', 'Reset a password',             'admin',  84),
  ('users.permissions.admin',            'users', 'Change permissions',           'admin',  85),
  ('users.audit.view',                   'users', 'View the audit trail',         'view',   86),

  -- Data Upload
  ('data-upload.process.admin',          'data-upload', 'Run an upload/process',  'admin',  101);

-- 5c. Role defaults, transcribed verbatim from PAGE_ROLE_DEFAULTS in
--     lib/auth/roles.ts as of this migration. Behaviour-neutral: same access
--     as before, just readable from the database instead of a TS constant.
insert into core.role_permissions (role, permission_key) values
  ('super_admin','network.view'),('ho_admin','network.view'),('regional_manager','network.view'),('ebo_manager','network.view'),('marketing','network.view'),
  ('super_admin','stock-details.view'),('ho_admin','stock-details.view'),('regional_manager','stock-details.view'),('ebo_manager','stock-details.view'),('marketing','stock-details.view'),
  ('super_admin','replenishment.view'),('ho_admin','replenishment.view'),('regional_manager','replenishment.view'),('ebo_manager','replenishment.view'),('marketing','replenishment.view'),
  ('super_admin','footfall.view'),('ho_admin','footfall.view'),('ebo_manager','footfall.view'),
  ('super_admin','targets.view'),('ho_admin','targets.view'),('regional_manager','targets.view'),('ebo_manager','targets.view'),
  ('super_admin','workspace.view'),('ho_admin','workspace.view'),('regional_manager','workspace.view'),('ebo_manager','workspace.view'),('marketing','workspace.view'),
  ('super_admin','ecomm.view'),('ho_admin','ecomm.view'),('marketing','ecomm.view'),
  ('super_admin','users.view'),
  ('super_admin','integrations.view'),
  ('super_admin','data-upload.view'),('ho_admin','data-upload.view'),
  ('super_admin','configurations.view');

-- 5d. Feature defaults: every role that can reach a page gets ALL of that
--     page's features. This is what makes the migration behaviour-neutral —
--     nothing becomes newly hidden the moment 0079 is applied. Admins narrow
--     from here. (Admin-class features on admin-only pages are already
--     protected by the page grant above being super_admin-only.)
insert into core.role_permissions (role, permission_key)
select rp.role, fk.key
from core.role_permissions rp
join core.feature_keys page on page.key = rp.permission_key and page.is_page
join core.feature_keys fk on fk.page_key = page.page_key and not fk.is_page
on conflict do nothing;

-- 5e. Carry existing per-user page overrides into the new key space.
insert into core.user_permission_overrides (user_id, permission_key, allowed)
select o.user_id, o.page_key || '.view', o.allowed
from core.user_page_overrides o
on conflict (user_id, permission_key) do nothing;

-- =============================================================================
-- RLS
-- =============================================================================
-- Reads: the resolver (lib/auth/access.ts) runs as the CALLING user, so it
-- needs to read the config tables and its own override rows.
-- Writes: all go through server actions using the admin/service_role client,
-- which bypasses RLS, and which do their own requireSuperAdminCaller() check.
-- So no write policy is granted to `authenticated` anywhere below.

alter table core.role_permissions enable row level security;
alter table core.feature_keys enable row level security;
alter table core.user_permission_overrides enable row level security;
alter table core.admin_audit_log enable row level security;

-- Config tables are readable by any signed-in user: the resolver needs them
-- on every request, and "which pages does each role get" is app configuration,
-- not sensitive data.
create policy role_permissions_read on core.role_permissions
  for select using (true);

create policy feature_keys_read on core.feature_keys
  for select using (true);

-- A user sees only their OWN overrides; super_admin sees everyone's (the
-- admin UI needs the full picture). Same shape as 0003's profiles policies.
create policy user_permission_overrides_read on core.user_permission_overrides
  for select using (
    user_id = core.current_user_id()
    or core.fn_user_role() = 'super_admin'
  );

-- Audit is super_admin-only, read-only. No insert/update/delete policy at all.
create policy admin_audit_log_read on core.admin_audit_log
  for select using (core.fn_user_role() = 'super_admin');

grant select on core.role_permissions to authenticated;
grant select on core.feature_keys to authenticated;
grant select on core.user_permission_overrides to authenticated;
grant select on core.admin_audit_log to authenticated;

grant all on core.role_permissions to service_role;
grant all on core.feature_keys to service_role;
grant all on core.user_permission_overrides to service_role;
-- Audit: INSERT and SELECT only. No update/delete for anyone, so the trail
-- is append-only at the privilege level, not merely by convention.
grant select, insert on core.admin_audit_log to service_role;
grant usage, select on sequence core.admin_audit_log_id_seq to service_role;

notify pgrst, 'reload schema';
