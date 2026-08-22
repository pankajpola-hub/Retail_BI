import { redirect } from "next/navigation";

// Merged into /movement (Phase 2 nav consolidation) — this route stays as a
// redirect stub so old links/bookmarks still land somewhere useful, just
// without deep filter state (acceptable for an internal tool where the nav
// link is the primary path). See web/app/(replenishment)/movement/page.tsx.
export default function ReplenishmentRedirect() {
  redirect("/movement?tab=replenishment");
}
