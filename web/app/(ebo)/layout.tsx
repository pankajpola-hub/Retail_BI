import { requireRole } from "@/lib/auth/roles";
import { TopNav } from "@/components/ui/TopNav";

export default async function EboLayout({ children }: { children: React.ReactNode }) {
  // super_admin/ho_admin included so HO can view/test any store's EBO
  // screens — same pattern as every other route group. fn_user_store_ids()
  // returns every store for those roles, so storeIds[0] below just picks
  // the alphabetically-first store for them, not a "their store" concept.
  const user = await requireRole("ebo_manager", "super_admin", "ho_admin");

  return (
    <div className="mx-auto max-w-xl px-5 pb-16">
      <TopNav role={user.role} fullName={user.fullName} userId={user.id} />
      {children}
    </div>
  );
}
