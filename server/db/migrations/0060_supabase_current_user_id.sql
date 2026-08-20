-- =============================================================================
-- 0060 · core.current_user_id() -> auth.uid()  [SUPABASE TARGET ONLY]
-- =============================================================================
-- This project moved from the self-hosted stack (Keycloak + Postgres +
-- PostgREST) to a real Supabase project (2026-08-20). 0003's definition read
-- an `app.user_id` GUC set per-request by the self-hosted PostgREST
-- `db-pre-request` hook (core.fn_postgrest_pre_request) — that hook has no
-- equivalent on Supabase's managed PostgREST, and there is no GUC to read.
--
-- 0044 already worked out the correct replacement — `select auth.uid()`,
-- Supabase's built-in JWT-subject accessor — but was retracted at the time
-- because it got applied to the wrong (legacy, unused) Supabase project while
-- production still ran self-hosted. That reasoning no longer applies: this
-- really is the live Supabase target now. Reapplying the same logic here,
-- honestly renumbered, rather than reviving the retracted file, so migration
-- history stays an accurate record of what happened when.
--
-- Every dependent function/policy (core.fn_user_role, core.fn_user_store_ids,
-- and every RLS policy across the schema — confirmed 116 call sites across
-- 31 migration files) is written in terms of core.current_user_id() rather
-- than auth.uid() directly, so this one redefinition is sufficient to
-- propagate everywhere; no other policy DDL needs touching.
--
-- core.fn_postgrest_pre_request (0003's GUC-setting hook) is now dead code —
-- left in place rather than dropped, since it's harmless and unreferenced by
-- Supabase's own PostgREST configuration.
create or replace function core.current_user_id()
returns uuid
language sql
stable
as $$
  select auth.uid();
$$;
