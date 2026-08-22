import { requireRole } from "@/lib/auth/roles";
import { AppShell } from "@/components/ui/AppShell";

// Coarse role gate (layer 1) — same "no dedicated Ecomm role yet" reasoning
// as PAGE_ROLE_DEFAULTS.ecomm in lib/auth/roles.ts. The finer business_unit
// check (does this ho_admin/super_admin actually hold an 'ecomm' grant) runs
// in the page itself via requirePageAccess("ecomm"), same split every other
// route group here uses.
export default async function EcommLayout({ children }: { children: React.ReactNode }) {
  const user = await requireRole("ho_admin", "super_admin");

  return (
    <AppShell role={user.role} fullName={user.fullName} userId={user.id} businessUnits={user.businessUnits}>
      {children}
    </AppShell>
  );
}
