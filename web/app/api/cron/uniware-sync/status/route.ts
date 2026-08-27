import { NextResponse } from "next/server";
import { cronAuthFailure } from "@/lib/cron/auth";
import { createAdminClient } from "@/lib/data/admin";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

type SyncRunRow = {
  id: number;
  started_at: string;
  finished_at: string | null;
  header_orders_upserted: number;
  item_orders_processed: number;
  item_orders_failed: number;
  errors: string[];
  success: boolean | null;
};

/**
 * Read-only sync health check for web/app/api/cron/uniware-sync — "did
 * yesterday's sync succeed" without querying Postgres directly (0068's
 * header). Returns the last N raw_uniware.sync_runs rows via
 * ops.fn_uniware_sync_runs, same SECURITY DEFINER door the cron route
 * writes through (raw_uniware isn't PostgREST-exposed — see 0065's header).
 *
 * Protected with the same CRON_SECRET bearer check as the sync route itself,
 * not left open: sync_runs.errors can contain raw SOAP fault strings and
 * order codes (see 0068), which is internal operational detail, not
 * something to expose unauthenticated even read-only. A future monitoring
 * integration (e.g. an uptime check) gets the same secret Vercel Cron
 * already uses, rather than a second credential to manage.
 */
export async function GET(request: Request) {
  // Fail-closed shared secret check — see lib/cron/auth.ts (audit B-07).
  const denied = cronAuthFailure(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const requested = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(Math.trunc(requested), MAX_LIMIT) : DEFAULT_LIMIT;

  const admin = await createAdminClient();
  const { data, error } = await admin.schema("ops").rpc<SyncRunRow[]>("fn_uniware_sync_runs", { p_limit: limit });

  if (error) {
    return NextResponse.json({ ok: false, error: { code: "query_failed", message: error.message } }, { status: 500 });
  }

  const runs = data ?? [];
  const latest = runs[0] ?? null;

  return NextResponse.json({
    ok: true,
    data: {
      // Convenience summary of the single most recent run, so a caller
      // doesn't have to inspect runs[0] itself for the common "is it healthy
      // right now" check.
      latest: latest
        ? { startedAt: latest.started_at, finishedAt: latest.finished_at, success: latest.success, errorCount: latest.errors?.length ?? 0 }
        : null,
      runs,
    },
  });
}
