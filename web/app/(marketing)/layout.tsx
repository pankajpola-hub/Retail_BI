import { requireRole } from "@/lib/auth/roles";
import { TopNav } from "@/components/ui/TopNav";

export default async function MarketingLayout({ children }: { children: React.ReactNode }) {
  const user = await requireRole("marketing", "ho_admin", "super_admin");

  return (
    <div className="mx-auto max-w-[1240px] px-6 pb-24">
      <TopNav role={user.role} fullName={user.fullName} userId={user.id} />
      {children}
    </div>
  );
}
