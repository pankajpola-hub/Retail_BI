-- =============================================================================
-- 0078 · Saved filter views — Phase 1 of the faceted-filtering system
--        (Movement/Replenishment tab; page_key is a free-text
--        discriminator so this one table serves every future page's saved
--        views too, not just this one).
-- =============================================================================
-- Same owner-only RLS shape as ops.scheduled_exports (0071) and
-- ops.alert_subscriptions (0072): owner_id = core.current_user_id(), full
-- CRUD for the owner, nothing visible to anyone else.

create table ops.saved_filter_views (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references core.profiles(user_id),
  page_key    text not null,
  name        text not null,
  state       jsonb not null,
  created_at  timestamptz not null default now(),
  unique (owner_id, page_key, name)
);

create index idx_saved_filter_views_owner_page on ops.saved_filter_views (owner_id, page_key);

alter table ops.saved_filter_views enable row level security;

create policy saved_filter_views_owner_all on ops.saved_filter_views
  for all
  using (owner_id = core.current_user_id())
  with check (owner_id = core.current_user_id());

grant select, insert, update, delete on ops.saved_filter_views to authenticated;
grant all on ops.saved_filter_views to service_role;

notify pgrst, 'reload schema';
