import { requirePageAccess } from "@/lib/auth/roles";
import { AppShell } from "@/components/ui/AppShell";

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  // Same pattern as (stock-details)/layout.tsx — one page in this group, so
  // the layout-level gate can be page-key-specific. See lib/auth/roles.ts
  // PAGE_ROLE_DEFAULTS.workspace for why this is broad: every workspace is
  // owner-scoped at the RLS layer (migration 0049), so widening who can
  // reach this page only ever grants access to a role's OWN workspaces.
  const user = await requirePageAccess("workspace");

  return (
    <AppShell role={user.role} fullName={user.fullName} userId={user.id}>
      {children}
    </AppShell>
  );
}
