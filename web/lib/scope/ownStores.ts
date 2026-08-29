/**
 * Narrows a `core.stores` result to the stores the caller actually holds.
 *
 * WHY THIS IS NEEDED, stated plainly, because the codebase previously
 * assumed the opposite in a comment (web/app/(ebo)/footfall/page.tsx said
 * "core.stores is RLS-filtered to the caller's permitted stores already"):
 * it is NOT. Verified 2026-08-29 against the live database —
 * `core.stores` has `relrowsecurity = false`, ZERO policies in
 * `pg_policies`, and `SELECT` granted to `authenticated`. Every signed-in
 * user can read the entire store roster.
 *
 * That is harmless for the FIGURES: every sales/stock/footfall/target
 * relation this app reads is scoped, either by a
 * `store_id = any(core.fn_user_store_ids())` predicate baked into the view
 * (the whole `sales.vw_ebo_*` chain, rooted at `sales.vw_ebo_sales_lines`)
 * or by an RLS policy with the same predicate (`ops.ebo_footfall_daily`,
 * `ops.ebo_targets`, `ops.ebo_monthly_targets`, `ops.daily_target_remarks`,
 * `ops.stock_availability_snapshot`). Picking someone else's store in a
 * filter returns zero rows, not their numbers.
 *
 * It is NOT harmless for the store PICKERS built out of it. A single-store
 * user offered a dropdown of every branch in the company learns the roster,
 * and selecting one silently yields a blank page rather than an error —
 * so the control is both a small disclosure and visibly broken. Worse, two
 * pages picked their DEFAULT store as `storeList[0]`, which for a
 * single-store user is usually somebody else's store, landing them on an
 * empty page by default.
 *
 * `storeIds` is the caller's `core.fn_user_store_ids()` result, already
 * resolved once per request by requirePageAccess()/requireRole() and handed
 * back as `CurrentUser.storeIds` — pass that, don't re-derive it. For
 * super_admin/ho_admin that array is every store, so this is a no-op for
 * them and their view is unchanged.
 */
export function ownStores<T extends { store_id: string }>(
  stores: T[] | null | undefined,
  storeIds: string[]
): T[] {
  const granted = new Set(storeIds);
  return (stores ?? []).filter((s) => granted.has(s.store_id));
}
