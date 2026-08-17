-- Phase 7 RLS proof. Runs as the `authenticated` role with core.current_user_id()
-- driven by the app.user_id GUC (0003), which is exactly how PostgREST drives it
-- per request. No accounts are created; two synthetic user UUIDs are simulated.
\set ON_ERROR_STOP on
\pset pager off

-- Seed two identities and a workspace owned by ALICE, as a superuser (RLS bypassed).
set role postgres;
delete from workspace.workspace_permissions where owner_id in
  ('aaaaaaaa-0000-0000-0000-00000000000a','bbbbbbbb-0000-0000-0000-00000000000b');
delete from workspace.workspaces where owner_id in
  ('aaaaaaaa-0000-0000-0000-00000000000a','bbbbbbbb-0000-0000-0000-00000000000b');

insert into workspace.workspaces (id, name, owner_id, type, is_default)
values ('11111111-0000-0000-0000-000000000001', 'Alice private', 'aaaaaaaa-0000-0000-0000-00000000000a', 'personal', false);

insert into workspace.workspace_components (workspace_id, component_id, grid_w, grid_h)
values ('11111111-0000-0000-0000-000000000001', 'sales_kpi_grid', 6, 4);

insert into workspace.workspace_filters (workspace_id, dimension_id, operator, values)
values ('11111111-0000-0000-0000-000000000001', 'store', 'in', array['BO-001']);

\echo ''
\echo '=== 1. BOB (no grant) must see NOTHING of Alice''s workspace ==='
set role authenticated;
select set_config('app.user_id', 'bbbbbbbb-0000-0000-0000-00000000000b', false);
select 'bob sees workspaces: ' || count(*) as r from workspace.workspaces
  where id = '11111111-0000-0000-0000-000000000001';
select 'bob sees components: ' || count(*) as r from workspace.workspace_components
  where workspace_id = '11111111-0000-0000-0000-000000000001';
select 'bob sees filters:    ' || count(*) as r from workspace.workspace_filters
  where workspace_id = '11111111-0000-0000-0000-000000000001';

\echo ''
\echo '=== 2. BOB cannot forge a grant to himself (owner_id WITH CHECK) ==='
do $$
begin
  insert into workspace.workspace_permissions (workspace_id, principal_id, owner_id, granted_by)
  values ('11111111-0000-0000-0000-000000000001',
          'bbbbbbbb-0000-0000-0000-00000000000b',
          'aaaaaaaa-0000-0000-0000-00000000000a',
          'bbbbbbbb-0000-0000-0000-00000000000b');
  raise notice 'FAIL  bob forged a grant naming Alice as owner';
exception when insufficient_privilege or check_violation then
  raise notice 'PASS  bob blocked from forging a grant (RLS WITH CHECK)';
end $$;

\echo ''
\echo '=== 3. ALICE grants view to BOB ==='
select set_config('app.user_id', 'aaaaaaaa-0000-0000-0000-00000000000a', false);
insert into workspace.workspace_permissions (workspace_id, principal_id, owner_id, granted_by)
values ('11111111-0000-0000-0000-000000000001',
        'bbbbbbbb-0000-0000-0000-00000000000b',
        'aaaaaaaa-0000-0000-0000-00000000000a',
        'aaaaaaaa-0000-0000-0000-00000000000a');
select 'alice grant rows: ' || count(*) as r from workspace.workspace_permissions
  where workspace_id = '11111111-0000-0000-0000-000000000001';

\echo ''
\echo '=== 4. BOB can now READ workspace + components + filters (no recursion) ==='
select set_config('app.user_id', 'bbbbbbbb-0000-0000-0000-00000000000b', false);
select 'bob sees workspaces: ' || count(*) as r from workspace.workspaces
  where id = '11111111-0000-0000-0000-000000000001';
select 'bob sees components: ' || count(*) as r from workspace.workspace_components
  where workspace_id = '11111111-0000-0000-0000-000000000001';
select 'bob sees filters:    ' || count(*) as r from workspace.workspace_filters
  where workspace_id = '11111111-0000-0000-0000-000000000001';

\echo ''
\echo '=== 5. BOB still CANNOT write to it (read-only share) ==='
do $$
begin
  update workspace.workspaces set name = 'hijacked' where id = '11111111-0000-0000-0000-000000000001';
  if found then raise notice 'FAIL  bob UPDATED a shared workspace'; else raise notice 'PASS  bob UPDATE affected 0 rows'; end if;
end $$;
do $$
begin
  delete from workspace.workspace_components where workspace_id = '11111111-0000-0000-0000-000000000001';
  if found then raise notice 'FAIL  bob DELETED shared components'; else raise notice 'PASS  bob DELETE affected 0 rows'; end if;
end $$;
do $$
begin
  insert into workspace.workspace_components (workspace_id, component_id, grid_w, grid_h)
  values ('11111111-0000-0000-0000-000000000001', 'store_league_table', 6, 4);
  raise notice 'FAIL  bob INSERTED into a shared workspace';
exception when insufficient_privilege or check_violation then
  raise notice 'PASS  bob blocked from INSERTing into a shared workspace';
end $$;

\echo ''
\echo '=== 6. BOB cannot re-share it onward ==='
do $$
begin
  insert into workspace.workspace_permissions (workspace_id, principal_id, owner_id, granted_by)
  values ('11111111-0000-0000-0000-000000000001',
          'cccccccc-0000-0000-0000-00000000000c',
          'bbbbbbbb-0000-0000-0000-00000000000b',
          'bbbbbbbb-0000-0000-0000-00000000000b');
  raise notice 'NOTE  bob inserted a row claiming HIMSELF as owner — check it grants nothing';
exception when insufficient_privilege or check_violation then
  raise notice 'PASS  bob blocked from re-sharing';
end $$;
-- Even if such a row exists, Carol must still see nothing, because the
-- workspaces policy requires a grant row AND that row is Bob-owned garbage
-- pointing at a workspace Bob does not own.
select set_config('app.user_id', 'cccccccc-0000-0000-0000-00000000000c', false);
select 'carol sees workspaces: ' || count(*) as r from workspace.workspaces
  where id = '11111111-0000-0000-0000-000000000001';

\echo ''
\echo '=== 7. BOB forks it — copy is HIS, source is untouched ==='
select set_config('app.user_id', 'bbbbbbbb-0000-0000-0000-00000000000b', false);
select workspace.fn_fork_workspace('11111111-0000-0000-0000-000000000001', 'Bob copy') as forked_id \gset
select 'fork owner is bob: ' || (owner_id = 'bbbbbbbb-0000-0000-0000-00000000000b')::text as r
  from workspace.workspaces where id = :'forked_id';
select 'fork type personal: ' || (type = 'personal')::text as r
  from workspace.workspaces where id = :'forked_id';
select 'fork copied components: ' || count(*)::text as r
  from workspace.workspace_components where workspace_id = :'forked_id';
select 'fork copied filters: ' || count(*)::text as r
  from workspace.workspace_filters where workspace_id = :'forked_id';
select 'fork inherited NO grants: ' || (count(*) = 0)::text as r
  from workspace.workspace_permissions where workspace_id = :'forked_id';
select set_config('app.user_id', 'aaaaaaaa-0000-0000-0000-00000000000a', false);
select 'source name unchanged: ' || (name = 'Alice private')::text as r
  from workspace.workspaces where id = '11111111-0000-0000-0000-000000000001';
select 'source still has 1 component: ' || (count(*) = 1)::text as r
  from workspace.workspace_components where workspace_id = '11111111-0000-0000-0000-000000000001';

\echo ''
\echo '=== 8. CAROL (no grant) cannot fork what she cannot read ==='
select set_config('app.user_id', 'cccccccc-0000-0000-0000-00000000000c', false);
do $$
begin
  perform workspace.fn_fork_workspace('11111111-0000-0000-0000-000000000001', 'Carol steal');
  raise notice 'FAIL  carol forked a workspace she cannot read';
exception when others then
  raise notice 'PASS  carol blocked from forking: %', sqlerrm;
end $$;

\echo ''
\echo '=== 9. Revoking the grant removes BOB''s access ==='
select set_config('app.user_id', 'aaaaaaaa-0000-0000-0000-00000000000a', false);
delete from workspace.workspace_permissions
  where workspace_id = '11111111-0000-0000-0000-000000000001'
    and principal_id = 'bbbbbbbb-0000-0000-0000-00000000000b';
select set_config('app.user_id', 'bbbbbbbb-0000-0000-0000-00000000000b', false);
select 'bob sees workspaces after revoke: ' || count(*) as r from workspace.workspaces
  where id = '11111111-0000-0000-0000-000000000001';
select 'bob KEEPS his fork: ' || count(*) as r from workspace.workspaces where id = :'forked_id';

-- Cleanup
set role postgres;
delete from workspace.workspaces where owner_id in
  ('aaaaaaaa-0000-0000-0000-00000000000a','bbbbbbbb-0000-0000-0000-00000000000b','cccccccc-0000-0000-0000-00000000000c');
delete from workspace.workspace_permissions where owner_id in
  ('aaaaaaaa-0000-0000-0000-00000000000a','bbbbbbbb-0000-0000-0000-00000000000b','cccccccc-0000-0000-0000-00000000000c');
\echo ''
\echo '=== cleanup done ==='
