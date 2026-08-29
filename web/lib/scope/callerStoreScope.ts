import "server-only";
import type { DataClient } from "@/lib/data/client";

/**
 * The caller's own store grants, read from the same single source of truth
 * every other page uses: core.fn_user_store_ids() (all stores for
 * super_admin/ho_admin/service_role, the explicit core.user_store_access
 * grants for everyone else — see that function's definition).
 *
 * Why this exists as its own helper, in lib/replenishment specifically:
 *
 * Replenishment (lib/replenishment/compute.ts) and Sale vs Stock Mix
 * (lib/replenishment/mix.ts) are the app's ONLY two features that read
 * sales.vw_stock_with_scheme / sales.vw_sale_transactions_export — the two
 * deliberately UNSCOPED views (no `store_id = any(core.fn_user_store_ids())`
 * predicate, unlike the whole sales.vw_ebo_* family, and unlike their own
 * `_scoped` siblings that /stock-details and the Workspace stock renderer
 * use). That is by design and is NOT a bug: a network allocation engine
 * deciding whether to move stock FROM one store TO another has to see every
 * store's stock and demand simultaneously, or it cannot compute the
 * recommendation at all.
 *
 * The consequence, though, is that RLS provides zero protection for these
 * two code paths — so the store boundary has to be re-imposed in app code,
 * on the OUTPUT, after the network-wide computation is done. Both compute
 * functions therefore do exactly that at their `return`: the maths stays
 * network-wide, the rows handed back to any caller are narrowed to the
 * caller's own stores. Doing it at the compute boundary rather than in each
 * page/component is deliberate — there are five consumers (the Movement
 * page's two tabs, /api/replenishment/download, and the two Workspace
 * renderers), and a per-consumer filter is one forgotten call site away
 * from a leak.
 *
 * FAILS CLOSED. Unlike core.fn_user_business_units()'s handling in
 * lib/auth/roles.ts — which fails OPEN, and says why: it is UX convenience
 * layered over an RLS boundary that still holds independently — there is no
 * RLS boundary underneath this one. An unresolvable grant list here means
 * "we do not know what this user may see", and the only safe answer to that
 * is to refuse rather than to guess, so this throws instead of returning an
 * empty set (which would silently render as a plausible-looking "no data"
 * page) or a full set.
 *
 * DOES NOT PROTECT SERVICE-ROLE CALLERS. core.fn_user_store_ids()'s very
 * first branch returns every row of core.stores when the request's JWT role
 * is `service_role`, so passing an admin client (lib/data/admin.ts) here
 * resolves to "all stores" — correct for that function's purpose, useless as
 * a boundary. Any unattended/cron path that builds a report FOR a particular
 * user must therefore resolve that user's stores from their explicit
 * owner_id instead: see resolveOwnerStoreIds() in lib/exports/scheduledExports.ts,
 * which re-evaluates the same role/user_store_access rules in TypeScript.
 * (The scheduled Replenishment export was leaking the whole network for
 * exactly this reason until 2026-08-29.)
 */
export async function resolveCallerStoreScope(supabase: DataClient): Promise<Set<string>> {
  const { data, error } = await supabase.schema("core").rpc<string[]>("fn_user_store_ids");
  if (error) {
    throw new Error(
      `Could not resolve the caller's store access (core.fn_user_store_ids): ${error.message}. ` +
        `Refusing to render network-wide replenishment data without it.`
    );
  }
  return new Set(data ?? []);
}
