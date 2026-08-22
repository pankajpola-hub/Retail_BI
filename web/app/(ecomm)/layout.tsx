import { requireRole } from "@/lib/auth/roles";
import { AppShell } from "@/components/ui/AppShell";

// Coarse role gate (layer 1) — mirrors PAGE_ROLE_DEFAULTS.ecomm in
// lib/auth/roles.ts (see that entry's comment for why `marketing` is
// included alongside ho_admin/super_admin, and why there's still no
// dedicated Ecomm role). The finer business_unit check (does this caller
// actually hold an 'ecomm' grant) runs in the page itself via
// requirePageAccess("ecomm"), same split every other route group here uses.
export default async function EcommLayout({ children }: { children: React.ReactNode }) {
  const user = await requireRole("ho_admin", "super_admin", "marketing");

  return (
    <AppShell role={user.role} fullName={user.fullName} userId={user.id} businessUnits={user.businessUnits}>
      {children}
    </AppShell>
  );
}
