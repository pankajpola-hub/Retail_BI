-- =============================================================================
-- 0100 · Rename the "network" permission/page key to "sales"
-- =============================================================================
-- /network has been a plain redirect stub since /sales replaced it (the
-- "unified Sales explore" work) — the nav link has pointed straight at
-- /sales for a while, and /sales's own access gate just got wired up to
-- requirePageAccess("sales") for the first time (it previously used a plain
-- requireRole() call that bypassed per-user overrides entirely). The TS-side
-- PageKey/PAGE_LABELS/PAGE_ROLE_DEFAULTS/PAGE_BUSINESS_UNIT all already moved
-- from "network" to "sales" in the matching app commit — this migration is
-- the DB-side half of that same rename, for the two tables that store the
-- key as free text: core.role_permissions (seeded role defaults, including
-- feature-level keys like "network.agent_sales.view") and core.feature_keys
-- (the admin-UI feature registry, migration 0079/0080).
--
-- SAFE TO RUN: core.user_permission_overrides and core.user_page_overrides
-- (the two tables that would carry a live PER-USER override) were checked
-- against the live database before writing this migration and have ZERO
-- rows referencing "network" in either — nobody has a personal override on
-- this key today, so there is nothing to lose by renaming the role-default
-- rows under it.
--
-- IDEMPOTENT: every statement below only touches rows that still start with
-- "network" or equal "network" — a second run finds nothing left to rename
-- and is a no-op.

begin;

-- Page-level and feature-level role-default rows: "network.view",
-- "network.agent_sales.view", "network.store_league.view", etc. — replace
-- only the LEADING "network" segment, not any hypothetical substring match
-- elsewhere in a key.
update core.role_permissions
set permission_key = 'sales' || substring(permission_key from 8)  -- 8 = length('network') + 1
where permission_key = 'network' or permission_key like 'network.%';

-- Feature registry: both the key itself and the page_key column it's
-- grouped under.
update core.feature_keys
set key = 'sales' || substring(key from 8)
where key = 'network' or key like 'network.%';

update core.feature_keys
set page_key = 'sales'
where page_key = 'network';

-- Defensive, since these should already be empty per the pre-check above —
-- if either somehow has a row, it must follow the rename too rather than
-- silently point at a permission key that no longer exists.
update core.user_permission_overrides
set permission_key = 'sales' || substring(permission_key from 8)
where permission_key = 'network' or permission_key like 'network.%';

update core.user_page_overrides
set page_key = 'sales'
where page_key = 'network';

-- Verification query (informational — shows in psql output). Expect 0 rows.
select count(*) as remaining_network_keys
from (
  select permission_key as k from core.role_permissions where permission_key like 'network%'
  union all
  select key from core.feature_keys where key like 'network%'
  union all
  select page_key from core.feature_keys where page_key = 'network'
  union all
  select permission_key from core.user_permission_overrides where permission_key like 'network%'
  union all
  select page_key from core.user_page_overrides where page_key = 'network'
) t;

commit;
