import { requirePageAccess } from "@/lib/auth/roles";
import { TopNav } from "@/components/ui/TopNav";

export default async function ReplenishmentLayout({ children }: { children: React.ReactNode }) {
  // Gates both /replenishment and /sale-stock-mix (added later, same
  // "replenishment" pageKey/role list — see the "Sale Mix vs Stock Mix"
  // page's own comment for why it wasn't given a separate PageKey) — a
  // single per-user override on "replenishment" controls access to both.
  const user = await requirePageAccess("replenishment");

  return (
    <div className="mx-auto max-w-[1240px] px-6 pb-24">
      <TopNav role={user.role} fullName={user.fullName} userId={user.id} />
      {children}
    </div>
  );
}
