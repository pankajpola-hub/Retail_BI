import { NextResponse } from "next/server";
import { cronAuthFailure } from "@/lib/cron/auth";
import { createAdminClient } from "@/lib/data/admin";
import { runDueAlerts } from "@/lib/alerts/runDueAlerts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Vercel Cron target — see vercel.json's schedule. Same shared-secret auth
 * shape as app/api/cron/uniware-sync and app/api/cron/scheduled-exports:
 * Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}` on scheduled
 * invocations, anything else is rejected before any email goes out.
 *
 * Runs once daily (vercel.json), covers both 'daily' and 'weekly'
 * subscriptions — runDueAlerts itself decides which rows are actually due.
 */
export async function GET(request: Request) {
  // Fail-closed shared secret check — see lib/cron/auth.ts (audit B-07).
  const denied = cronAuthFailure(request);
  if (denied) return denied;

  const admin = await createAdminClient();
  const errors: string[] = [];

  let data;
  try {
    data = await runDueAlerts(admin);
    errors.push(...data.errors);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`alerts run: ${message}`);
  }

  const ok = errors.length === 0;
  return NextResponse.json({ ok, data: data ?? null, errors });
}
