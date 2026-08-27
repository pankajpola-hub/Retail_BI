import { NextResponse } from "next/server";
import { cronAuthFailure } from "@/lib/cron/auth";
import { createAdminClient } from "@/lib/data/admin";
import { runDueScheduledExports } from "@/lib/exports/scheduledExports";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Vercel Cron target — see vercel.json's schedule. Same shared-secret auth
 * shape as app/api/cron/uniware-sync: Vercel Cron sends
 * `Authorization: Bearer ${CRON_SECRET}` on scheduled invocations, anything
 * else (a stray request, a manual curl without the secret) is rejected
 * before any report is regenerated.
 *
 * Runs once daily (vercel.json) and covers BOTH 'daily' and 'weekly'
 * schedules in one invocation — runDueScheduledExports itself decides which
 * rows are actually due (last_run_at null, or older than the row's own
 * frequency window), so a single fixed daily trigger is enough; no separate
 * weekly cron entry needed.
 */
export async function GET(request: Request) {
  // Fail-closed shared secret check — see lib/cron/auth.ts (audit B-07).
  const denied = cronAuthFailure(request);
  if (denied) return denied;

  const admin = await createAdminClient();
  const errors: string[] = [];

  let data;
  try {
    data = await runDueScheduledExports(admin);
    errors.push(...data.errors);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`scheduled exports run: ${message}`);
  }

  const ok = errors.length === 0;
  return NextResponse.json({ ok, data: data ?? null, errors });
}
