import { requireRole } from "@/lib/auth/roles";
import { AppShell } from "@/components/ui/AppShell";

export default async function HoLayout({ children }: { children: React.ReactNode }) {
  // super_admin included: full network access per docs/rbac-auth-setup.md Â§3.
  // ebo_manager and marketing included because ROLE_HOME now sends every
  // role here post-login (lib/auth/roles.ts) â€” the page itself is read-only
  // and every query is already scoped by core.fn_user_store_ids(), so a
  // store-scoped role seeing it changes what they see, not what they can do.
  const user = await requireRole(
    "ho_admin",
    "regional_manager",
    "super_admin",
    "ebo_manager",
    "marketing"
  );

  return (
    <AppShell role={user.role} fullName={user.fullName} userId={user.id} businessUnits={user.businessUnits}>
      {children}
    </AppShell>
  );
}
