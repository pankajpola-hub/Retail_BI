-- =============================================================================
-- 0080 · Turn on the first feature-level permission gates (Network).
-- =============================================================================
-- 0079 seeded core.feature_keys with enforced = false for every feature,
-- because the admin UI renders ONLY enforced keys: a toggle whose server-side
-- gate doesn't exist yet is a lie an admin would reasonably trust.
--
-- These four now have real gates in app/(ho)/network/page.tsx, so they flip on
-- here. Each later page's gates get their own small migration like this one,
-- rather than one big flip at the end — that way "is this key enforced?" is
-- always answerable from the schema, and the answer is always true.
--
-- Behaviour is unchanged for everyone on apply: 0079's seed granted every
-- feature to every role that can reach its page, so the gates evaluate to
-- `true` for all existing users until an admin explicitly denies one.

update core.feature_keys
   set enforced = true
 where key in (
   'network.store_league.view',
   'network.scheme_penetration.view',
   'network.agent_sales.view',
   'network.store_diagnosis.view'
 );

notify pgrst, 'reload schema';
