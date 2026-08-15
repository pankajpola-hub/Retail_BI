import { redirect } from "next/navigation";
import { createClient } from "@/lib/data/client";
import { ROLE_HOME, type AppRole } from "@/lib/auth/roles";

// Single place that turns "logged in" into "landed on the right home page" —
// see lib/auth/roles.ts ROLE_HOME. middleware.ts already guarantees a
// session exists before this renders.
export default async function RootPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .schema("core")
    .from<{ role: AppRole }>("profiles")
    .select("role")
    .eq("user_id", user.id)
    .single();

  if (!profile) redirect("/login?error=not_provisioned");

  redirect(ROLE_HOME[profile.role]);
}
