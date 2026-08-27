import { redirect } from "next/navigation";
import { requirePageAccess } from "@/lib/auth/roles";

// Merged into /movement (Phase 2 nav consolidation) — this route stays as a
// redirect stub so old links/bookmarks still land somewhere useful, just
// without deep filter state (acceptable for an internal tool where the nav
// link is the primary path). See web/app/(replenishment)/movement/page.tsx.
//
// requirePageAccess runs before the redirect for symmetry with the other two
// redirect stubs (/network, /ecomm): the group layout already enforces access,
// but gating here attributes the denial to this page's own key.
export default async function SaleStockMixRedirect() {
  await requirePageAccess("replenishment");
  redirect("/movement?tab=mix");
}
