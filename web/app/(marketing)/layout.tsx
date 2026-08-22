import { requireRole } from "@/lib/auth/roles";
import { AppShell } from "@/components/ui/AppShell";

export default async function MarketingLayout({ children }: { children: React.ReactNode }) {
  const user = await requireRole("marketing", "ho_admin", "super_admin");

  return (
    <AppShell role={user.role} fullName={user.fullName} userId={user.id} businessUnits={user.businessUnits}>
      {children}
    </AppShell>
  );
}
