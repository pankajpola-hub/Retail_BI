import { requirePageAccess } from "@/lib/auth/roles";
import { createAdminClient } from "@/lib/data/admin";
import { LogicErpForm } from "./logic-erp-form";
import { getDict } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

type CredentialsRow = {
  host: string;
  port: number;
  database_name: string;
  db_user: string;
  updated_at: string;
};

export default async function IntegrationsPage() {
  // requirePageAccess (migration 0035) layers a per-user override on top of
  // the role default — (admin)/layout.tsx's gate is coarse (it also hosts
  // /users, a different page_key), so the "integrations" page_key check has
  // to happen here instead.
  await requirePageAccess("integrations");
  const t = await getDict();

  // Admin client, deliberately — core.integration_credentials has no RLS
  // policies at all (see 0021 migration), so even a super_admin's own
  // session can't read it directly. This selects only the safe columns;
  // db_password_enc is never fetched here regardless.
  const admin = await createAdminClient();
  const { data: existing } = await admin
    .schema("core")
    .from<CredentialsRow>("integration_credentials")
    .select("host, port, database_name, db_user, updated_at")
    .eq("integration_name", "logic_erp")
    .maybeSingle();

  return (
    <main className="py-6">
      <h1 className="font-serif text-2xl">{t.integrationsTitle}</h1>
      <p className="mt-1 max-w-2xl text-[12.5px] text-ink-3">{t.integrationsSubtitle}</p>

      <div className="mt-6 max-w-md">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
          Logic ERP (SQL Server, LAN)
        </h2>
        <div className="mt-3">
          <LogicErpForm
            existing={
              existing
                ? {
                    host: existing.host,
                    port: existing.port,
                    databaseName: existing.database_name,
                    dbUser: existing.db_user,
                    updatedAt: existing.updated_at,
                  }
                : null
            }
          />
        </div>
      </div>
    </main>
  );
}
