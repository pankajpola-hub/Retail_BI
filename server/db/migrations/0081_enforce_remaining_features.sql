-- =============================================================================
-- 0081 · Enforce the rest of the feature keys, and drop three that describe
--        capabilities this app does not actually have.
-- =============================================================================
-- Every key turned on below now has a real server-side gate. See 0080's header
-- for why enforcement is flipped per batch rather than all at once: the admin
-- UI renders only enforced keys, so a key is visible exactly when toggling it
-- does something.
--
-- Behaviour is unchanged on apply — 0079's seed granted every feature to every
-- role that can reach its page, so all of these evaluate to `true` for existing
-- users until an admin explicitly denies one.

-- --------------------------------------------------------------------------
-- Phantom keys. 0079 seeded these speculatively; auditing the codebase while
-- wiring the gates showed there is nothing to gate:
--   * stock-details.stock.export / ecomm.orders.export — no export route
--     exists for either page (the only download routes are data-upload,
--     footfall, replenishment and the targets audit report).
--   * workspace.share.edit — lib/workspace/actions.ts exports shareWorkspace()
--     but NO UI calls it, so there is no control to hide.
-- A registry listing capabilities the product doesn't have is the same class
-- of lie as a toggle that does nothing. Re-add them alongside the feature if
-- one is ever built.
-- --------------------------------------------------------------------------
delete from core.user_permission_overrides
 where permission_key in (
   'stock-details.stock.export',
   'ecomm.orders.export',
   'workspace.share.edit'
 );

delete from core.role_permissions
 where permission_key in (
   'stock-details.stock.export',
   'ecomm.orders.export',
   'workspace.share.edit'
 );

delete from core.feature_keys
 where key in (
   'stock-details.stock.export',
   'ecomm.orders.export',
   'workspace.share.edit'
 );

-- --------------------------------------------------------------------------
-- Everything else now has a gate.
-- --------------------------------------------------------------------------
update core.feature_keys
   set enforced = true
 where key in (
   -- Network (the remaining six; four went live in 0080)
   'network.vertical_rollup.view',
   'network.exceptions.view',
   'network.alert_subscription.edit',
   'network.week_wise_sales.view',
   'network.footfall_matrix.view',
   'network.traffic_sales_matrix.view',
   -- Movement. The two tab keys reconcile against each other in page.tsx:
   -- landing on a denied tab falls through to the other rather than rendering
   -- an empty page.
   'replenishment.recommendations.view',
   'replenishment.mix.view',
   'replenishment.whatif.edit',
   'replenishment.recommendations.export',
   -- Stock Details
   'stock-details.capacity.edit',
   -- Targets
   'targets.tracker.view',
   'targets.monthly_targets.edit',
   'targets.bulk_upload.edit',
   'targets.incentive_upload.edit',
   'targets.remarks.edit',
   'targets.audit_report.export',
   -- Users. These make a NARROWER admin possible — someone who can review
   -- users and the audit trail without resetting passwords or rewriting
   -- permissions. All granted to super_admin by default.
   'users.invite.admin',
   'users.role.admin',
   'users.status.admin',
   'users.password.admin',
   'users.permissions.admin',
   'users.audit.view',
   -- Data Upload
   'data-upload.process.admin'
 );

notify pgrst, 'reload schema';
