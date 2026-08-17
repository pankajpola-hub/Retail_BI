-- =============================================================================
-- 0052 · Phase 7: workspace sharing + personalize-a-copy (blueprint §G).
--        Additive. Creates workspace.workspace_permissions, widens
--        workspaces.type, and adds READ-ONLY RLS paths for grantees.
--
-- =============================================================================
-- THE SECURITY PROPERTY THAT MATTERS MOST — READ BEFORE CHANGING ANYTHING HERE
-- =============================================================================
-- Sharing a workspace shares its LAYOUT, never its DATA.
--
-- A workspace row stores which components sit where, and a filter scope. It
-- stores no sales figures. Every number a component renders is fetched at
-- request time through sales.*/ops.* views that are themselves scoped by
-- core.fn_user_store_ids() FOR THE VIEWER (0003), and through the query
-- planner, which only ever NARROWS within what RLS already permits
-- (lib/workspace/queryPlanner.ts header).
--
-- So when an ho_admin shares a network-wide workspace with an ebo_manager,
-- the ebo_manager sees the same CARDS scoped to their OWN store — not the
-- ho_admin's network totals. There is no impersonation, no owner-context
-- execution, and nothing here runs SECURITY DEFINER.
--
-- This is why sharing can be added without re-auditing every view: the data
-- boundary was never the workspace's to enforce. Do NOT "fix" a report of
-- "shared workspace shows different numbers for different people" by making
-- components execute as the owner — that difference IS the security model.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Scope, deliberately narrow, following 0049's own precedent of constraining a
-- column now and widening it in the phase that actually needs it:
--
--   * capability is CHECK-constrained to 'view' ONLY. The column exists so
--     Phase 8+ can add 'edit' without a schema migration, but an edit grant
--     would need UPDATE/DELETE policies that do not exist below, and a grant
--     that silently behaved as read-only would be a lie. Constrained rather
--     than half-implemented.
--   * principal_type allows 'user' and 'role', but only the 'user' path has
--     RLS policies below. Same reasoning. Role-based sharing also needs a
--     decision about whether it means "every current holder of this role" or
--     a snapshot, which is a product question, not a schema one.
--   * No re-share: a grantee cannot grant onward, because only the owner can
--     write to workspace_permissions (policy below).
-- -----------------------------------------------------------------------------

create table workspace.workspace_permissions (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspace.workspaces(id) on delete cascade,

  principal_type text not null default 'user' check (principal_type in ('user', 'role')),
  principal_id   text not null,        -- Keycloak user uuid as text, or a core.app_role name
  capability     text not null default 'view' check (capability = 'view'),

  -- DENORMALIZED from workspaces.owner_id, and NOT redundant bookkeeping —
  -- it exists to break an RLS recursion cycle. The workspaces SELECT policy
  -- below must query this table to decide if a grantee may read a workspace.
  -- If this table's own policies queried workspaces back (to find the owner),
  -- Postgres would recurse between the two policies and error at query time.
  -- Carrying owner_id here lets every policy on this table answer using only
  -- its own columns. Set it from the workspace row when granting; a wrong
  -- value grants nothing extra (the owner still needs the workspaces policy
  -- to see the workspace at all), it only orphans the row from its owner's
  -- management view.
  owner_id       uuid not null,

  granted_by     uuid not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- One grant per principal per workspace — regranting updates, never stacks.
  unique (workspace_id, principal_type, principal_id)
);

create index idx_workspace_permissions_principal
  on workspace.workspace_permissions (principal_type, principal_id);
create index idx_workspace_permissions_workspace
  on workspace.workspace_permissions (workspace_id);
create index idx_workspace_permissions_owner
  on workspace.workspace_permissions (owner_id);

comment on table workspace.workspace_permissions is
  'Phase 7 sharing grants. Read-only ("view") only — see migration 0052 header. Sharing conveys LAYOUT, not data access: components always resolve through the VIEWER''s RLS scope.';

create trigger set_updated_at before update on workspace.workspace_permissions
  for each row execute function extensions.moddatetime(updated_at);

alter table workspace.workspace_permissions enable row level security;

-- Owner manages grants. Uses the denormalized owner_id, never a join back to
-- workspaces — see the column comment.
create policy workspace_permissions_owner_all on workspace.workspace_permissions
  for all
  using (owner_id = core.current_user_id())
  with check (owner_id = core.current_user_id());

-- A grantee may read the row that names them, so the app can show "shared
-- with you" without the owner's privileges. Read-only, and scoped to rows
-- naming this exact user — never a blanket select.
create policy workspace_permissions_principal_select on workspace.workspace_permissions
  for select
  using (principal_type = 'user' and principal_id = core.current_user_id()::text);

grant select, insert, update, delete on workspace.workspace_permissions to authenticated;
grant all on workspace.workspace_permissions to service_role;


-- -----------------------------------------------------------------------------
-- Widen workspaces.type. 0049 pinned it to 'personal' with a CHECK; Phase 7
-- introduces 'shared' (a personal workspace that has been granted out) and
-- 'official' (curated, owned by an admin). A CHECK cannot be altered in
-- place, so drop and recreate — this rewrites no data and changes no
-- existing row, since every current row is 'personal' and stays valid.
-- -----------------------------------------------------------------------------
alter table workspace.workspaces drop constraint if exists workspaces_type_check;
alter table workspace.workspaces
  add constraint workspaces_type_check check (type in ('personal', 'shared', 'official'));


-- -----------------------------------------------------------------------------
-- Grantee READ paths. These are additional PERMISSIVE policies: Postgres ORs
-- permissive policies for the same command, so 0049's owner-all policies keep
-- working untouched and these only ever ADD read access for an explicitly
-- named principal. Nothing below grants INSERT/UPDATE/DELETE to a grantee —
-- a shared workspace is strictly read-only, and "personalize" is a FORK into
-- the caller's own workspace (see fn_fork_workspace below), which is what the
-- acceptance bar means by "official dashboards stay unchanged when a user
-- personalizes a copy."
-- -----------------------------------------------------------------------------
create policy workspaces_shared_select on workspace.workspaces
  for select
  using (
    exists (
      select 1 from workspace.workspace_permissions p
      where p.workspace_id = workspace.workspaces.id
        and p.principal_type = 'user'
        and p.principal_id = core.current_user_id()::text
    )
  );

-- Components and filters of a shared workspace, same rule. These query
-- workspace_permissions directly rather than routing through workspaces, so
-- the policy chain stays one level deep and cannot recurse.
create policy workspace_components_shared_select on workspace.workspace_components
  for select
  using (
    exists (
      select 1 from workspace.workspace_permissions p
      where p.workspace_id = workspace.workspace_components.workspace_id
        and p.principal_type = 'user'
        and p.principal_id = core.current_user_id()::text
    )
  );

create policy workspace_filters_shared_select on workspace.workspace_filters
  for select
  using (
    exists (
      select 1 from workspace.workspace_permissions p
      where p.workspace_id = workspace.workspace_filters.workspace_id
        and p.principal_type = 'user'
        and p.principal_id = core.current_user_id()::text
    )
  );


-- -----------------------------------------------------------------------------
-- Personalize-a-copy. Deep-copies a workspace the caller can READ into a new
-- workspace the caller OWNS, including components and filters.
--
-- SECURITY INVOKER (the default) is load-bearing and must stay that way: the
-- SELECTs below run as the caller, so RLS decides what is copyable. A user
-- who cannot read the source workspace copies nothing and gets an error —
-- this function cannot be used to read someone else's workspace. Making it
-- SECURITY DEFINER would turn it into exactly that hole.
--
-- The copy is always type 'personal', is_default false, owned by the caller,
-- and carries NO permissions — forking never inherits the source's grants.
-- -----------------------------------------------------------------------------
create or replace function workspace.fn_fork_workspace(p_source_id uuid, p_new_name text)
returns uuid
language plpgsql
as $$
declare
  v_caller uuid := core.current_user_id();
  v_new_id uuid;
begin
  if v_caller is null then
    raise exception 'fn_fork_workspace: no authenticated caller';
  end if;

  -- RLS-scoped: returns no row unless the caller owns or was granted the source.
  if not exists (select 1 from workspace.workspaces w where w.id = p_source_id) then
    raise exception 'fn_fork_workspace: source workspace % not found or not readable', p_source_id;
  end if;

  insert into workspace.workspaces (name, owner_id, type, is_default)
  values (coalesce(nullif(trim(p_new_name), ''), 'Copy of workspace'), v_caller, 'personal', false)
  returning id into v_new_id;

  insert into workspace.workspace_components
    (workspace_id, component_id, grid_x, grid_y, grid_w, grid_h, config, sort_order)
  select v_new_id, c.component_id, c.grid_x, c.grid_y, c.grid_w, c.grid_h, c.config, c.sort_order
  from workspace.workspace_components c
  where c.workspace_id = p_source_id;

  insert into workspace.workspace_filters (workspace_id, dimension_id, operator, values)
  select v_new_id, f.dimension_id, f.operator, f.values
  from workspace.workspace_filters f
  where f.workspace_id = p_source_id;

  return v_new_id;
end;
$$;

comment on function workspace.fn_fork_workspace(uuid, text) is
  'Deep-copies a readable workspace into a new one owned by the caller. SECURITY INVOKER by design — RLS governs what can be copied; see migration 0052.';

grant execute on function workspace.fn_fork_workspace(uuid, text) to authenticated;

notify pgrst, 'reload schema';
