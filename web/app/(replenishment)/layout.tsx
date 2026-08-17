import { requirePageAccess } from "@/lib/auth/roles";
import { AppShell } from "@/components/ui/AppShell";

export default async function ReplenishmentLayout({ children }: { children: React.ReactNode }) {
  // Gates both /replenishment and /sale-stock-mix (added later, same
  // "replenishment" pageKey/role list — see the "Sale Mix vs Stock Mix"
  // page's own comment for why it wasn't given a separate PageKey) — a
  // single per-user override on "replenishment" controls access to both.
  const user = await requirePageAccess("replenishment");

  return (
    <AppShell role={user.role} fullName={user.fullName} userId={user.id}>
      {children}
    </AppShell>
  );
}
