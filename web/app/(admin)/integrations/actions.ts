"use server";

import { z } from "zod";
import sql from "mssql";
import { createClient } from "@/lib/data/client";
import { createAdminClient } from "@/lib/data/admin";

const credentialsSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535),
  databaseName: z.string().min(1),
  dbUser: z.string().min(1),
  // Blank ("") means "keep the currently stored password" — only valid when
  // a row already exists, which fn_save_logic_erp_credentials enforces
  // itself (a first-ever insert with a NULL password fails the column's NOT
  // NULL constraint, so an empty submission on a brand-new integration
  // fails loudly rather than silently storing a blank credential).
  dbPassword: z.string(),
});

async function requireSuperAdmin() {
  const supabase = await createClient();
  const {
    data: { user: caller },
  } = await supabase.auth.getUser();
  if (!caller) throw new Error("Not authenticated.");

  const { data: callerProfile } = await supabase
    .schema("core")
    .from<{ role: string }>("profiles")
    .select("role")
    .eq("user_id", caller.id)
    .single();

  if (callerProfile?.role !== "super_admin") {
    throw new Error("Only super_admin can manage integration credentials.");
  }
  return caller;
}

// RFC1918 / link-local / loopback ranges. A host in one of these is only
// reachable from something ALSO on that LAN — Vercel's serverless functions
// run in AWS and have no route to it, so a test from here will time out no
// matter how correct the credentials are. Distinct from "wrong credentials"
// and worth telling the admin explicitly, otherwise a correct LAN server
// looks indistinguishable from a genuinely broken one.
function isPrivateLanHost(host: string): boolean {
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (host === "localhost" || host.endsWith(".local")) return true;
  // A bare hostname with no dot at all (e.g. "AMIR-TAMBOLI") is a Windows
  // machine/NetBIOS name — resolvable via LAN name resolution (or the local
  // hosts file) but not through public DNS, which is all Vercel's servers
  // can reach. Confirmed live: this exact shape failed with
  // "getaddrinfo EBUSY amir-tamboli", not a credentials error.
  return !host.includes(".");
}

/**
 * Storage only — this does not connect to Logic ERP, it just lands the
 * details securely for whoever builds that connector next (see the 0021
 * migration header). Re-checks super_admin independently of the (admin)
 * layout gate, same reasoning as inviteUser in ../users/actions.ts: a
 * Server Action is directly callable and must not assume the layout ran.
 */
export async function saveLogicErpCredentials(input: z.infer<typeof credentialsSchema>) {
  const caller = await requireSuperAdmin();
  const { host, port, databaseName, dbUser, dbPassword } = credentialsSchema.parse(input);

  const passphrase = process.env.INTEGRATION_SECRET_KEY;
  if (!passphrase) {
    // Fails loudly rather than silently storing with a guessed/empty
    // passphrase — a credential encrypted under the wrong key is worse than
    // one that visibly failed to save.
    throw new Error("Server is missing INTEGRATION_SECRET_KEY — credentials were not saved.");
  }

  // await: unlike Supabase's synchronous createAdminClient(), the
  // self-hosted one fetches a service-role token first, so this is async.
  const admin = await createAdminClient();
  const { error } = await admin.schema("core").rpc("fn_save_logic_erp_credentials", {
    p_host: host,
    p_port: port,
    p_database_name: databaseName,
    p_db_user: dbUser,
    // The generated RPC type says non-null, but the Postgres function
    // genuinely accepts and relies on NULL here (see 0021 migration) — the
    // generator has no way to know a param is nullable from
    // information_schema alone.
    p_db_password: (dbPassword || null) as string,
    p_passphrase: passphrase,
    p_updated_by: caller.id,
  });

  if (error) throw new Error(error.message);
}

/**
 * Tests the connection using whatever is currently typed into the form —
 * NOT what's saved. Nothing here writes to the database; this is purely a
 * "can I reach this and log in" check, connect -> SELECT 1 -> disconnect,
 * with a short timeout so a dead host fails fast instead of hanging the
 * request. Never logs the password.
 */
export async function testLogicErpConnection(input: z.infer<typeof credentialsSchema>) {
  await requireSuperAdmin();
  const { host, port, databaseName, dbUser, dbPassword } = credentialsSchema.parse(input);

  if (!dbPassword) {
    return {
      ok: false,
      message: "Enter the password to test — the saved one is encrypted and can't be reused here.",
    };
  }

  const lanWarning = isPrivateLanHost(host)
    ? " This is a private/LAN address — this test runs from Vercel's servers, which have no network path to your office LAN, so a timeout here is expected and doesn't mean the credentials are wrong. A real connection will only work once a connector running ON that LAN uses them."
    : "";

  // A fresh ConnectionPool instance, not the sql.connect() shorthand — that
  // shorthand manages ONE shared global pool per process, which a
  // serverless function could reuse across unrelated test calls (different
  // admin, different server) in ways that are hard to reason about. This
  // keeps every test fully isolated.
  let pool: sql.ConnectionPool | null = null;
  try {
    pool = new sql.ConnectionPool({
      server: host,
      port,
      database: databaseName,
      user: dbUser,
      password: dbPassword,
      connectionTimeout: 8000,
      requestTimeout: 8000,
      options: {
        // Logic ERP is an internal LAN box, not a cert-managed public
        // endpoint — encrypt the session but don't require a trusted CA.
        encrypt: true,
        trustServerCertificate: true,
      },
    });
    await pool.connect();
    await pool.request().query("SELECT 1");
    return { ok: true, message: "Connected successfully." };
  } catch (err) {
    const raw = err instanceof Error ? err.message : "Connection failed.";
    return { ok: false, message: raw + lanWarning };
  } finally {
    if (pool) {
      try {
        await pool.close();
      } catch {
        // Best-effort cleanup — a failure to close doesn't change the
        // test result already computed above.
      }
    }
  }
}
