import { requirePageAccess } from "@/lib/auth/roles";
import { TopNav } from "@/components/ui/TopNav";

export default async function DataUploadLayout({ children }: { children: React.ReactNode }) {
  // This route group has exactly one page (data-upload), so the layout-level
  // gate can be page-key-specific — requirePageAccess layers the per-user
  // override (migration 0035) on top of the role default. See
  // lib/auth/roles.ts PAGE_ROLE_DEFAULTS for the "data-upload" role list.
  const user = await requirePageAccess("data-upload");

  return (
    <div className="mx-auto max-w-[1240px] px-6 pb-24">
      <TopNav role={user.role} fullName={user.fullName} userId={user.id} />
      {children}
    </div>
  );
}
