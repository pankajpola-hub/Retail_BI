-- =============================================================================
-- 0049 · Phase 5: Workspace Builder instance tables (blueprint §K). Additive
--        only. This is where the registry (0047) and semantic layer (0048)
--        stop being a read-only catalogue and start backing something a
--        user can actually save — a personal workspace of components with a
--        layout and a scope (store/date filters).
--
-- Deliberately narrow, per the roadmap's own phase order:
--   - type is constrained to 'personal' at the CHECK level for now. The
--     column exists (and 'official'/'shared' are valid per the blueprint's
--     target design) so Phase 7 (Personalization) doesn't need a schema
--     migration to add them — but nothing in this phase creates one, and no
--     "personalize the official workspace without changing it" logic exists
--     yet. One user, one or more personal workspaces, full stop.
--   - workspace_filters covers exactly what the 6 wired-up Sales components
--     use today: a date range and a store list. Not the full cascading
--     filter engine (Phase 6).
--   - No sharing/permissions beyond "the owner can do everything, nobody
--     else can see it." workspace_permissions (blueprint §G) is NOT created
--     here — there is exactly one principal (the owner) in this phase, so a
--     permissions table would have nothing to express yet. Added when
--     Phase 7 actually needs to grant a second principal something.
-- =============================================================================

create table workspace.workspaces (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  owner_id     uuid not null,                 -- Keycloak user id, same core.profiles.user_id join as everywhere else
  type         text not null default 'personal' check (type = 'personal'),
  is_default   boolean not null default false,
  version      int not null default 1,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index idx_workspaces_owner on workspace.workspaces (owner_id);
-- At most one default workspace per owner — "restore default" needs this to be unambiguous.
create unique index idx_workspaces_one_default_per_owner on workspace.workspaces (owner_id) where is_default;

create table workspace.workspace_components (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspace.workspaces(id) on delete cascade,
  component_id  text not null references workspace.component_definitions(id),
  grid_x        int not null default 0,
  grid_y        int not null default 0,
  grid_w        int not null,
  grid_h        int not null,
  config        jsonb not null default '{}'::jsonb, -- per-component overrides; unused by the 6 wired-up components today (they inherit the workspace's filters), reserved for Phase 8 (Smart Components)
  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index idx_workspace_components_workspace on workspace.workspace_components (workspace_id);

create table workspace.workspace_filters (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspace.workspaces(id) on delete cascade,
  dimension_id  text not null references workspace.dimension_definitions(id),
  operator      text not null default 'in' check (operator in ('in', 'range')),
  values        text[] not null default '{}',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (workspace_id, dimension_id)
);

create trigger set_updated_at before update on workspace.workspaces
  for each row execute function extensions.moddatetime(updated_at);
create trigger set_updated_at before update on workspace.workspace_components
  for each row execute function extensions.moddatetime(updated_at);
create trigger set_updated_at before update on workspace.workspace_filters
  for each row execute function extensions.moddatetime(updated_at);

alter table workspace.workspaces enable row level security;
alter table workspace.workspace_components enable row level security;
alter table workspace.workspace_filters enable row level security;

-- Owner-only, full stop — see header on why workspace_permissions doesn't
-- exist yet. core.current_user_id() is the same self-hosted GUC-based
-- identity function every other RLS policy in this app uses (0003).
create policy workspaces_owner_all on workspace.workspaces
  for all
  using (owner_id = core.current_user_id())
  with check (owner_id = core.current_user_id());

-- Components/filters are owned indirectly through their workspace — same
-- "join back to the owning row" pattern, not a duplicated owner_id column.
create policy workspace_components_owner_all on workspace.workspace_components
  for all
  using (exists (select 1 from workspace.workspaces w where w.id = workspace_id and w.owner_id = core.current_user_id()))
  with check (exists (select 1 from workspace.workspaces w where w.id = workspace_id and w.owner_id = core.current_user_id()));

create policy workspace_filters_owner_all on workspace.workspace_filters
  for all
  using (exists (select 1 from workspace.workspaces w where w.id = workspace_id and w.owner_id = core.current_user_id()))
  with check (exists (select 1 from workspace.workspaces w where w.id = workspace_id and w.owner_id = core.current_user_id()));

grant select, insert, update, delete on
  workspace.workspaces, workspace.workspace_components, workspace.workspace_filters
  to authenticated;
grant all on
  workspace.workspaces, workspace.workspace_components, workspace.workspace_filters
  to service_role;
