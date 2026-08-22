import { redirect } from "next/navigation";
import { createClient } from "@/lib/data/client";
import { resolveHome, type AppRole, type BusinessUnit } from "@/lib/auth/roles";

// Single place that turns "logged in" into "landed on the right home page" —
// see lib/auth/roles.ts's resolveHome. middleware.ts already guarantees a
// session exists before this renders.
//
// Was a bare ROLE_HOME[role] lookup — business-unit-blind, so an ecomm-only
// user (no 'retail' grant) landed on /network straight after login and was
// immediately bounced (denied, then redirected right back to /network) —
// same bug resolveHome's own doc comment describes, fixed here the same way.
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

  const { data: businessUnits } = await supabase.schema("core").rpc<BusinessUnit[]>("fn_user_business_units");

  redirect(resolveHome(profile.role, businessUnits ?? []));
}
