-- =============================================================================
-- 0053 · SECURITY FIX for 0052. Closes a full authorization bypass in
--        workspace.workspace_permissions. Apply immediately after 0052;
--        0052 must never be deployed anywhere without this.
--
-- THE BUG
--
-- 0052 protected workspace_permissions with:
--     using      (owner_id = core.current_user_id())
--     with check (owner_id = core.current_user_id())
-- and let the grantee-read policies on workspaces/components/filters trust
-- any row in that table.
--
-- owner_id was supplied by the CLIENT. The WITH CHECK only proved the caller
-- had written their OWN id into it — not that they actually owned the
-- workspace being granted. So any authenticated user could run:
--
--     insert into workspace.workspace_permissions
--       (workspace_id, principal_id, owner_id, granted_by)
--     values (<any workspace id>, <any user>, <themselves>, <themselves>);
--
-- and the workspaces_shared_select policy would then hand that workspace's
-- layout, components and filters to the named principal — for a workspace
-- the inserter had never been granted and did not own. Combined with
-- fn_fork_workspace (which copies anything the caller can READ), an attacker
-- could grant themselves read on an arbitrary workspace and fork it.
--
-- 0052's own column comment asserted that a wrong owner_id "grants nothing
-- extra, it only orphans the row." That was simply false: owner_id was the
-- ONLY link between a grant and the workspace's real owner, so forging it
-- forged the entire authorization decision.
--
-- Caught by the Phase 7 RLS test before this reached an application layer;
-- no client code ever depended on the broken behavior.
--
-- THE FIX
--
-- RLS alone cannot express "owner_id must equal this workspace's real owner"
-- without the workspace_permissions policy querying workspace.workspaces,
-- which would recurse against the workspaces policy that queries
-- workspace_permissions. So the invariant is enforced by a BEFORE trigger
-- instead, which sits outside policy evaluation:
--
--   * the caller must BE the workspace's owner, verified against the
--     workspaces table authoritatively;
--   * owner_id and granted_by are OVERWRITTEN with server-derived values,
--     so whatever the client sent is irrelevant rather than merely checked.
--
-- The trigger function is SECURITY DEFINER purely so it can read
-- workspaces.owner_id without RLS filtering the row away (a non-owner
-- reading a workspace they were not granted correctly sees zero rows, which
-- would make the check unenforceable). It reads ONE column, compares it, and
-- returns — it exposes nothing and takes no client-controlled identifiers
-- into dynamic SQL. search_path is pinned per standard practice for
-- SECURITY DEFINER functions.
--
-- fn_fork_workspace stays SECURITY INVOKER — that was correct in 0052 and is
-- what keeps forking bounded by the caller's own read access.
-- =============================================================================

create or replace function workspace.fn_validate_permission_grant()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, workspace, core, pg_temp
as $$
declare
  v_owner  uuid;
  v_caller uuid := core.current_user_id();
begin
  if v_caller is null then
    raise exception 'workspace_permissions: no authenticated caller';
  end if;

  select w.owner_id into v_owner
  from workspace.workspaces w
  where w.id = new.workspace_id;

  if v_owner is null then
    raise exception 'workspace_permissions: workspace % does not exist', new.workspace_id;
  end if;

  -- The whole fix. Only the real owner may grant access to a workspace.
  if v_owner <> v_caller then
    raise exception
      'workspace_permissions: only the owner of workspace % may grant access to it', new.workspace_id
      using errcode = 'insufficient_privilege';
  end if;

  -- Derive these server-side rather than trusting (or merely validating) the
  -- client's values, so a forged owner_id is impossible by construction.
  new.owner_id   := v_owner;
  new.granted_by := v_caller;
  return new;
end;
$$;

comment on function workspace.fn_validate_permission_grant() is
  'Enforces that only a workspace''s real owner can grant access to it, and derives owner_id/granted_by server-side. SECURITY DEFINER solely to read workspaces.owner_id past RLS — see migration 0053.';

drop trigger if exists validate_permission_grant on workspace.workspace_permissions;
create trigger validate_permission_grant
  before insert or update on workspace.workspace_permissions
  for each row execute function workspace.fn_validate_permission_grant();

-- Defense in depth: even if a stale/forged row somehow exists, a grant is
-- only honoured when its owner_id matches the workspace's CURRENT owner.
-- This compares against the row already being evaluated, so it adds no query
-- and cannot recurse.
drop policy if exists workspaces_shared_select on workspace.workspaces;
create policy workspaces_shared_select on workspace.workspaces
  for select
  using (
    exists (
      select 1 from workspace.workspace_permissions p
      where p.workspace_id = workspace.workspaces.id
        and p.owner_id     = workspace.workspaces.owner_id
        and p.principal_type = 'user'
        and p.principal_id = core.current_user_id()::text
    )
  );

-- The component/filter policies gain the same owner-match requirement. These
-- must reach workspaces to learn the true owner; that is safe because the
-- workspaces policies only read workspace_permissions, whose own policies
-- read no other table — the chain terminates and cannot cycle.
drop policy if exists workspace_components_shared_select on workspace.workspace_components;
create policy workspace_components_shared_select on workspace.workspace_components
  for select
  using (
    exists (
      select 1
      from workspace.workspace_permissions p
      join workspace.workspaces w on w.id = p.workspace_id
      where p.workspace_id = workspace.workspace_components.workspace_id
        and p.owner_id     = w.owner_id
        and p.principal_type = 'user'
        and p.principal_id = core.current_user_id()::text
    )
  );

drop policy if exists workspace_filters_shared_select on workspace.workspace_filters;
create policy workspace_filters_shared_select on workspace.workspace_filters
  for select
  using (
    exists (
      select 1
      from workspace.workspace_permissions p
      join workspace.workspaces w on w.id = p.workspace_id
      where p.workspace_id = workspace.workspace_filters.workspace_id
        and p.owner_id     = w.owner_id
        and p.principal_type = 'user'
        and p.principal_id = core.current_user_id()::text
    )
  );

-- Any rows written while 0052 was live but 0053 was not are untrustworthy by
-- definition — their owner_id was client-supplied. Remove any that do not
-- match their workspace's real owner. On a fresh stack this deletes nothing.
delete from workspace.workspace_permissions p
using workspace.workspaces w
where w.id = p.workspace_id
  and p.owner_id <> w.owner_id;

notify pgrst, 'reload schema';
