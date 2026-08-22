-- =============================================================================
-- 0066 · schema ops — grant service_role USAGE
-- =============================================================================
-- Same class of gap as 0062, caught the same way: by a real call failing,
-- not by inspection. Every existing ops.fn_process_*_upload function is
-- called via the USER-scoped client (the calling browser session's own
-- role), which already has USAGE on ops — service_role never needed it
-- before because nothing service-role-authenticated ever called INTO ops.
-- 0065's Uniware sync functions are the first thing to do that (the cron
-- route has no user session, only the service-role admin client), and the
-- first real invocation failed with "permission denied for schema ops" —
-- EXECUTE was granted on the functions themselves (0065), but USAGE on the
-- schema they live in is a separate, prerequisite privilege.

grant usage on schema ops to service_role;

notify pgrst, 'reload schema';
