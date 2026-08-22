import { requirePageAccess } from "@/lib/auth/roles";
import { AppShell } from "@/components/ui/AppShell";

export default async function StockDetailsLayout({ children }: { children: React.ReactNode }) {
  // Widened from ho_admin/super_admin-only so every role can VIEW the new
  // admin-set base display capacity + its audit trail (migration 0026) â€”
  // the page itself still gates editing separately: capacity-editor.tsx
  // only renders inputs for ho_admin/super_admin, and the write path
  // (actions.ts's setStoreDisplayCapacity) independently re-checks the
  // caller's role again before writing, same pattern as (ho)/layout.tsx.
  // requirePageAccess (migration 0035) additionally layers a per-user
  // override on top of that role list â€” this route group has exactly one
  // page (stock-details), so the layout-level gate can be page-key-specific
  // without ambiguity, unlike (ho) or (admin) which host multiple pages.
  const user = await requirePageAccess("stock-details");

  return (
    <AppShell role={user.role} fullName={user.fullName} userId={user.id} businessUnits={user.businessUnits}>
      {children}
    </AppShell>
  );
}
