import { getValidAccessToken } from "@/lib/keycloak/session";
import { createClient } from "@/lib/postgrest/server";
import { TestLoginForm } from "./login-form";

export const dynamic = "force-dynamic";

/**
 * Isolated proving ground for the self-hosted Keycloak + PostgREST stack —
 * not linked from nav, not part of any production route group. Delete once
 * real pages have been migrated off lib/supabase/* and this stack is
 * exercised by the actual app instead.
 */
export default async function SelfHostedTestPage() {
  const session = await getValidAccessToken();

  let storesResult: unknown = null;
  let footfallResult: unknown = null;
  if (session) {
    const supabase = await createClient();
    storesResult = await supabase.schema("core").from("stores").select("store_id, store_name");
    footfallResult = await supabase
      .schema("ops")
      .from("ebo_footfall_daily")
      .select("store_id, date, footfall")
      .order("date", { ascending: false })
      .limit(3);
  }

  return (
    <main style={{ padding: 24, fontFamily: "monospace", maxWidth: 800 }}>
      <h1>Self-hosted stack test (not a real page)</h1>
      <TestLoginForm loggedIn={!!session} />

      {session && (
        <div style={{ marginTop: 24 }}>
          <h2>Session claims</h2>
          <pre>{JSON.stringify(session.claims, null, 2)}</pre>

          <h2>core.stores via PostgREST</h2>
          <pre>{JSON.stringify(storesResult, null, 2)}</pre>

          <h2>ops.ebo_footfall_daily via PostgREST (RLS-scoped to this user)</h2>
          <pre>{JSON.stringify(footfallResult, null, 2)}</pre>
        </div>
      )}
    </main>
  );
}
