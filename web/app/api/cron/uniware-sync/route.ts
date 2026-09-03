import { NextResponse } from "next/server";
import { cronAuthFailure } from "@/lib/cron/auth";
import { createAdminClient } from "@/lib/data/admin";
import { runUniwareSync } from "@/lib/uniware/syncJob";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Vercel Cron target — see vercel.json's schedule. Auth is a shared secret
 * Vercel sends as `Authorization: Bearer ${CRON_SECRET}` on scheduled
 * invocations; anything else (a stray request, a manual curl without the
 * secret) is rejected before any Uniware call is made.
 *
 * The actual sync logic lives in lib/uniware/syncJob.ts (extracted
 * 2026-09-03) — this route is now a thin HTTP wrapper around it, so the
 * SAME logic can also run from scripts/uniware-sync-standalone.ts on a
 * GitHub Actions schedule instead of (or alongside) this route. Vercel's
 * Hobby plan caps cron invocations at once/day platform-wide, which left
 * the item-enrichment queue permanently unable to keep up with new orders —
 * see docs/audit/PROGRESS.md's 2026-09-03 entry for the full story. This
 * route is kept for manual/ad hoc triggering (still useful, e.g. after a
 * config change) even once GitHub Actions owns the primary schedule.
 */
export async function GET(request: Request) {
  const denied = cronAuthFailure(request);
  if (denied) return denied;

  const admin = await createAdminClient();
  const { ok, summary, errors } = await runUniwareSync(admin);
  return NextResponse.json({ ok, data: summary, errors });
}
