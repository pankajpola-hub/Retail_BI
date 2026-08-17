import { requireRole } from "@/lib/auth/roles";
import { AppShell } from "@/components/ui/AppShell";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireRole("super_admin");

  return (
    <AppShell role={user.role} fullName={user.fullName} userId={user.id}>
      {children}
    </AppShell>
  );
}
