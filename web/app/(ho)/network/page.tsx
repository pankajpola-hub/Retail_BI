import { redirect } from "next/navigation";
import { requirePageAccess } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

/**
 * Superseded by /sales (Phase 2 of the unified Sales explore) — /sales
 * covers everything this page used to (rollup, store league, agents,
 * footfall/conversion matrices, store diagnosis, scheme penetration) plus
 * Ecomm's content in one place, gated per-vertical instead of by this
 * page's single business_unit. Kept as a redirect, not deleted, so old
 * links/bookmarks still land somewhere correct — and requirePageAccess
 * still runs first so a user without network access is denied here
 * exactly as before, rather than silently landing on /sales's broader
 * role gate.
 */
export default async function NetworkPage({
  searchParams,
}: {
  searchParams: { from?: string; to?: string; store?: string; bu?: string };
}) {
  await requirePageAccess("network");
  const params = new URLSearchParams();
  if (searchParams.bu) params.set("bu", searchParams.bu);
  if (searchParams.store) params.set("store", searchParams.store);
  if (searchParams.from) params.set("from", searchParams.from);
  if (searchParams.to) params.set("to", searchParams.to);
  const qs = params.toString();
  redirect(qs ? `/sales?${qs}` : "/sales");
}
