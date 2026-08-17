import { requireRole } from "@/lib/auth/roles";
import { AppShell } from "@/components/ui/AppShell";

export default async function EboLayout({ children }: { children: React.ReactNode }) {
  // super_admin/ho_admin included so HO can view/test any store's EBO
  // screens — same pattern as every other route group. fn_user_store_ids()
  // returns every store for those roles, so storeIds[0] below just picks
  // the alphabetically-first store for them, not a "their store" concept.
  const user = await requireRole("ebo_manager", "super_admin", "ho_admin");

  // Previously max-w-xl (narrower than every other group, since this is a
  // small phone-oriented form) — AppShell standardizes on the app-wide
  // 1240px content width. Content itself still doesn't stretch to fill it,
  // so this only affects how much empty margin surrounds it, not layout.
  return (
    <AppShell role={user.role} fullName={user.fullName} userId={user.id}>
      {children}
    </AppShell>
  );
}
