import { requirePageAccess } from "@/lib/auth/roles";
import { AppShell } from "@/components/ui/AppShell";

export default async function DataUploadLayout({ children }: { children: React.ReactNode }) {
  // This route group has exactly one page (data-upload), so the layout-level
  // gate can be page-key-specific — requirePageAccess layers the per-user
  // override (migration 0035) on top of the role default. See
  // lib/auth/roles.ts PAGE_ROLE_DEFAULTS for the "data-upload" role list.
  const user = await requirePageAccess("data-upload");

  return (
    <AppShell role={user.role} fullName={user.fullName} userId={user.id}>
      {children}
    </AppShell>
  );
}
