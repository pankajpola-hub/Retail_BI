import "server-only";
import { NextResponse } from "next/server";
import type { DataClient } from "@/lib/data/client";

type ProfileRow = { role: string };

/** The HO-admin pair used by every admin-only route in this tree. */
export const HO_ADMIN_ROLES = ["ho_admin", "super_admin"];

/**
 * The role gate that app/api/data-upload/download-merged/route.ts:79-91 has
 * always done inline, lifted into one place so the routes that were MISSING
 * it (audit B-04, B-05, B-06, B-09, B-11) all get exactly the same check
 * rather than five near-copies that can drift apart.
 *
 * Deliberately additive: this is an app-layer gate on top of Postgres RLS,
 * not a replacement for it. RLS + core.fn_user_store_ids() remains the real
 * boundary (see lib/auth/access.ts's own header) — the point of checking
 * here is to stop a non-admin BEFORE a service-role side effect that RLS
 * never sees, e.g. minting a signed Storage upload URL (B-04) or writing an
 * object to a bucket (B-06).
 *
 * Call it with an ALREADY-AUTHENTICATED user id (routes keep their own
 * getUser()/401 step first, unchanged). Returns a NextResponse to return
 * immediately, or null when the caller is allowed:
 *
 *     const denied = await roleFailure(supabase, user.id, "…message…");
 *     if (denied) return denied;
 *
 * The private `_shared` folder name keeps this out of Next's App Router
 * routing entirely (underscore-prefixed folders are private folders), so it
 * is a plain module and never an endpoint.
 */
export async function roleFailure(
  supabase: DataClient,
  userId: string,
  forbiddenMessage: string,
  allowedRoles: string[] = HO_ADMIN_ROLES
): Promise<NextResponse | null> {
  const { data: profile } = await supabase
    .schema("core")
    .from<ProfileRow>("profiles")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();

  if (!profile || !allowedRoles.includes(profile.role)) {
    return NextResponse.json({ ok: false, error: { code: "forbidden", message: forbiddenMessage } }, { status: 403 });
  }

  return null;
}
