-- =============================================================================
-- 0061 · core.user_business_units — Retail vs Ecomm access as a first-class
--        attribute, ahead of the Uniware (Ecomm) integration
-- =============================================================================
-- Every access check today answers "what role, what stores" — there is no
-- concept yet of "which BUSINESS this user should see at all". That concept
-- is about to matter: Ecomm (synced from Uniware) is landing as a second,
-- largely separate business inside the same app — different data, different
-- pages, mostly different people. business_unit is the gate checked BEFORE
-- role/store even apply — "can this user open the Ecomm section at all",
-- with role/store continuing to narrow WITHIN whichever unit(s) they have.
--
-- Modeled as a grants table, not an array/boolean pair on core.profiles,
-- for the same reason core.user_store_access is a table and not a column:
-- most users hold exactly one grant, a few (initially just super_admins)
-- hold both, and a table makes "both" just two rows instead of a second
-- schema shape to keep in sync.
--
-- Deliberately NOT wired into any existing view, RLS policy, or page-access
-- check yet — this migration only lands the data and the read function.
-- Enforcing it (requirePageAccess, AppShell's nav filter, and eventually the
-- Permit.io policy layer sitting in front of the app) is separate follow-up
-- work, once Permit.io's resources/roles are modeled. Same "land the data,
-- wire it up later" split as 0054_item_master.sql.

create type core.business_unit as enum ('retail', 'ecomm');

create table core.user_business_units (
  user_id        uuid not null references core.profiles (user_id) on delete cascade,
  business_unit  core.business_unit not null,
  granted_at     timestamptz not null default now(),
  primary key (user_id, business_unit)
);

comment on table core.user_business_units is
  'Which business(es) a user can see at all — checked before role/store scoping applies. One row per (user, unit); a user with access to both holds two rows. Not yet enforced anywhere (see 0061 header) — Ecomm has no pages or data to gate yet.';

-- Backfill: every user in this table today is Retail-only (Ecomm doesn't
-- exist yet), so every existing profile gets a 'retail' grant. Every
-- existing super_admin ALSO gets 'ecomm' now, matching the decision that
-- org-wide admins see both businesses while regular staff start scoped to
-- one — not because Ecomm has anything to show yet, but so a super_admin
-- flipping this on later doesn't need a separate grant step.
insert into core.user_business_units (user_id, business_unit)
select user_id, 'retail'
from core.profiles
on conflict do nothing;

insert into core.user_business_units (user_id, business_unit)
select user_id, 'ecomm'
from core.profiles
where role = 'super_admin'
on conflict do nothing;

-- Central "what business units can this caller see" function — same shape
-- and naming convention as core.fn_user_store_ids()/core.fn_user_role(), so
-- every future RLS policy or view calls this instead of re-deriving it.
-- Unlike fn_user_store_ids(), there is no super_admin/ho_admin auto-all
-- shortcut: business_unit access is explicit-grant-only for every role,
-- including super_admin (handled instead by the backfill above) — an admin
-- created after this migration still needs an explicit ecomm grant, which
-- keeps "who can see Ecomm" answerable by reading this table alone, rather
-- than also having to know which roles get an implicit bypass.
create or replace function core.fn_user_business_units()
returns core.business_unit[]
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select array_agg(business_unit)
  from core.user_business_units
  where user_id = core.current_user_id();
$$;

alter table core.user_business_units enable row level security;

-- Same posture as user_store_access_self_read (0003): a user reads their
-- own grants, super_admin/ho_admin read everyone's (needed for the Users
-- page's access-management UI). No authenticated-role write policy — grants
-- are only ever written by an admin screen via the service-role client,
-- same as user_store_access.
create policy user_business_units_self_read on core.user_business_units
  for select using (user_id = core.current_user_id() or core.fn_user_role() in ('super_admin', 'ho_admin'));

-- service_role already has BYPASSRLS on Supabase (0060's header) — no
-- separate service_role grant statement needed here, unlike the retired
-- self-hosted migrations that had to grant it explicitly.
grant select on core.user_business_units to authenticated;

notify pgrst, 'reload schema';
