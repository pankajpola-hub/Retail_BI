// One-off backfill: syncs every core.profiles row that existed BEFORE
// createUser() started calling syncPermitUser() automatically (see
// app/(admin)/users/actions.ts). Run once now; not needed again for users
// created after this wiring landed.
const { createClient } = require("@supabase/supabase-js");
const { Permit } = require("permitio");

const PERMIT_API_KEY = process.env.PERMIT_API_KEY;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!PERMIT_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing PERMIT_API_KEY / NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const permit = new Permit({ token: PERMIT_API_KEY, pdp: "https://cloudpdp.api.permit.io" });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

(async () => {
  const { data: profiles, error } = await supabase.schema("core").from("profiles").select("user_id, full_name, role");
  if (error) throw new Error(error.message);

  for (const p of profiles ?? []) {
    await permit.api.users.sync({ key: p.user_id, first_name: p.full_name });
    await permit.api.users.assignRole({ user: p.user_id, role: p.role, tenant: "default" });
    console.log(`synced: ${p.full_name} (${p.role})`);
  }
  console.log("Done.");
})().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
