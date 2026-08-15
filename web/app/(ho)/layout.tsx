import { requireRole } from "@/lib/auth/roles";
import { TopNav } from "@/components/ui/TopNav";

export default async function HoLayout({ children }: { children: React.ReactNode }) {
  // super_admin included: full network access per docs/rbac-auth-setup.md §3.
  // ebo_manager and marketing included because ROLE_HOME now sends every
  // role here post-login (lib/auth/roles.ts) — the page itself is read-only
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
    <div className="mx-auto max-w-[1240px] px-6 pb-24">
      <TopNav role={user.role} fullName={user.fullName} userId={user.id} />
      {children}
    </div>
  );
}
