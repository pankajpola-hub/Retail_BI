-- =============================================================================
-- 0057 · core.app_settings — first generic app-settings table in the project
-- =============================================================================
-- Backs the new admin-only "Configurations" section (2026-08-15). Free-text
-- key (no DB enum), same reasoning as core.user_page_overrides.page_key:
-- adding a new setting later should never require a migration.
--
-- Readable by any authenticated user (settings like the Fresh/EOSS
-- classification source affect what every role's dashboards compute, not
-- just the admin's own view) — writable only via the service-role client,
-- same posture as core.user_page_overrides (written only from
-- web/app/(admin)/users/actions.ts-style server actions).
-- =============================================================================

create table core.app_settings (
  key         text primary key,
  value       jsonb not null,
  updated_by  uuid references core.profiles (user_id),
  updated_at  timestamptz not null default now()
);

comment on table core.app_settings is
  'Generic admin-editable app settings, free-text key so a new setting never needs a migration (same reasoning as core.user_page_overrides.page_key). Readable by every authenticated user — a setting like fresh_disc_classification_source affects what every role''s queries compute, not just the admin''s own view. Written only via the service-role client from the /configurations admin page (super_admin only, see web/lib/auth/roles.ts PAGE_ROLE_DEFAULTS).';

alter table core.app_settings enable row level security;

create policy app_settings_read on core.app_settings
  for select using (true);

grant select on core.app_settings to authenticated;
-- Deliberately no insert/update/delete grant to authenticated — writes only
-- via the service-role client (bypasses RLS), matching user_page_overrides.

-- Seed the Fresh/EOSS classification-source setting. 'discount_ratio'
-- preserves today's live behavior exactly (gross/discount-amount ratio,
-- unchanged since 0025) — nothing changes for any user until an admin
-- explicitly switches this to 'scheme_lookup' on the new Configurations page.
insert into core.app_settings (key, value) values
  ('fresh_disc_classification_source', '{"source":"discount_ratio"}'::jsonb)
on conflict (key) do nothing;

comment on column core.app_settings.value is
  'jsonb so a setting can carry structure without a schema change. fresh_disc_classification_source: {"source": "discount_ratio"} (default, 0025''s 49.5%-of-gross rule) or {"source": "scheme_lookup"} (raw_logic.scheme_lookup.is_discounted_50plus by item_code, 0058) — see ops.fn_monthly_fresh_disc_tracker and ops.vw_monthly_fresh_disc_audit_lines.';
