import { redirect } from "next/navigation";
import { requirePageAccess } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

/**
 * Superseded by /sales (Phase 2 of the unified Sales explore) — /sales
 * renders this page's channel breakdown, top styles, and returns as its
 * ECOM section, gated per-vertical (resolveViewScope) rather than by this
 * page's single business_unit gate. Kept as a redirect, not deleted, so old
 * links/bookmarks still land somewhere correct — and requirePageAccess
 * still runs first so a user without ecomm access is denied here exactly
 * as before. Forces bu=ecomm on the target so a bookmark to this page keeps
 * showing only Ecomm content rather than switching to "all granted
 * verticals", /sales's default when bu is absent.
 */
export default async function EcommPage({
  searchParams,
}: {
  searchParams: { from?: string; to?: string; channel?: string };
}) {
  await requirePageAccess("ecomm");
  const params = new URLSearchParams();
  params.set("bu", "ecomm");
  if (searchParams.from) params.set("from", searchParams.from);
  if (searchParams.to) params.set("to", searchParams.to);
  if (searchParams.channel) params.set("channel", searchParams.channel);
  redirect(`/sales?${params.toString()}`);
}
