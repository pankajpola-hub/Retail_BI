import "server-only";
import type { DataClient } from "@/lib/data/client";
import { createAdminClient as createRawAdminClient } from "@/lib/supabase/admin";
import { resolveOwnerStoreIds } from "@/lib/exports/scheduledExports";
import { computeSalesTotals, type WeeklyRow } from "@/lib/sales/aggregate";
import { computeStoreExceptions } from "@/lib/sales/exceptions";
import { sendAlertDigest } from "@/lib/alerts/mailer";
import { getAlertMailerSettings } from "@/lib/alerts/settings";

// Threshold alerts: opt-in email digest of the exact same "Needs attention"
// exception feed /network's OverviewRollupSection shows — see
// ops.alert_subscriptions (0072) and lib/sales/exceptions.ts's header for
// why this is a shared extraction rather than a second definition.
//
// Same "admin client, no session, re-derive scoping explicitly" posture as
// lib/exports/scheduledExports.ts's runDueScheduledExports — reuses that
// file's resolveOwnerStoreIds rather than a second copy.

const FREQUENCY_WINDOW_MS: Record<string, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

type AlertSubscriptionRow = {
  id: string;
  owner_id: string;
  frequency: "daily" | "weekly";
  threshold_pct: number | string;
  last_run_at: string | null;
};

export type AlertRunSummary = {
  processed: number;
  sent: number;
  skipped: number;
  failed: number;
  errors: string[];
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isDue(row: AlertSubscriptionRow, now: Date): boolean {
  if (!row.last_run_at) return true;
  const windowMs = FREQUENCY_WINDOW_MS[row.frequency];
  if (!windowMs) return false;
  return now.getTime() - new Date(row.last_run_at).getTime() >= windowMs;
}

/**
 * Same trailing window network/page.tsx defaults to (27 days back from
 * today, plus one extra week so computeSalesTotals's WoW comparison has two
 * complete weeks to compare) — an unattended cron run has no page-provided
 * date range to inherit, so it uses the same "whole scope" default
 * scheduledExports.ts's report builders already establish for this
 * situation.
 */
function defaultWindow(now: Date): { from: string; weeklyStart: string; to: string } {
  const to = isoDate(now);
  const from = new Date(now);
  from.setDate(from.getDate() - 27);
  const weeklyStart = new Date(from);
  weeklyStart.setDate(weeklyStart.getDate() - 7);
  return { from: isoDate(from), weeklyStart: isoDate(weeklyStart), to };
}

/**
 * Finds every due ops.alert_subscriptions row, recomputes that owner's own
 * store exceptions, emails a digest when non-empty, and updates
 * last_run_at/last_sent_at. Called by app/api/cron/alerts's GET handler.
 * One row's failure doesn't abort the run — same posture as
 * runDueScheduledExports/uniware-sync.
 */
export async function runDueAlerts(admin: DataClient): Promise<AlertRunSummary> {
  const summary: AlertRunSummary = { processed: 0, sent: 0, skipped: 0, failed: 0, errors: [] };

  // Admin settings (Configurations → Alert digest, core.app_settings). Read
  // once per run, not per subscription. Defaults preserve the pre-settings
  // behaviour exactly, so an unwritten key never silently disables the digest.
  const settings = await getAlertMailerSettings(admin);
  if (!settings.enabled) return summary;

  const { data: allRows, error } = await admin
    .schema("ops")
    .from<AlertSubscriptionRow>("alert_subscriptions")
    .select("id, owner_id, frequency, threshold_pct, last_run_at");
  if (error) {
    summary.errors.push(`alert_subscriptions read: ${error.message}`);
    return summary;
  }

  const now = new Date();
  const due = (allRows ?? []).filter((row) => isDue(row, now));
  if (due.length === 0) return summary;

  const { from, weeklyStart, to } = defaultWindow(now);
  const rawAdmin = createRawAdminClient();

  const { data: stores } = await admin.schema("core").from<{ store_id: string; store_name: string }>("stores").select("store_id, store_name");
  const allStoreNames = new Map((stores ?? []).map((s) => [s.store_id, s.store_name]));

  for (const row of due) {
    summary.processed += 1;
    try {
      const storeIds = await resolveOwnerStoreIds(admin, row.owner_id);

      let sent = false;
      if (storeIds.length > 0) {
        const { data: weeks, error: weeksError } = await admin
          .schema("sales")
          .from<WeeklyRow>("vw_ebo_sales_weekly")
          .select("*")
          .in("store_id", storeIds)
          .gte("week_start", weeklyStart)
          .lte("week_start", to);
        if (weeksError) throw new Error(`vw_ebo_sales_weekly: ${weeksError.message}`);

        const { weekRows, storesInView } = computeSalesTotals(weeks, from);
        // A subscription's own threshold wins; the admin default only applies
        // when the row doesn't carry one.
        const threshold = Number(row.threshold_pct);
        const effectiveThreshold = Number.isFinite(threshold) ? threshold : settings.defaultThresholdPct;
        const exceptions = computeStoreExceptions(weekRows, storesInView, allStoreNames, effectiveThreshold);

        if (exceptions.length > 0 || !settings.skipWhenEmpty) {
          const { data: userResult, error: userError } = await rawAdmin.auth.admin.getUserById(row.owner_id);
          if (userError) throw new Error(`resolve owner email: ${userError.message}`);
          const email = userResult.user?.email;
          if (!email) throw new Error("owner has no email on their auth account");

          // Admin-configured extras go out alongside the subscriber's own
          // address — this is what lets a shared ops inbox receive the digest
          // without needing a Retail BI login. sendAlertDigest de-duplicates.
          await sendAlertDigest([email, ...settings.extraRecipients], exceptions);
          sent = true;
        }
      }

      const { error: updateError } = await admin
        .schema("ops")
        .from("alert_subscriptions")
        .update({ last_run_at: now.toISOString(), ...(sent ? { last_sent_at: now.toISOString() } : {}) })
        .eq("id", row.id);
      if (updateError) throw new Error(updateError.message);

      if (sent) summary.sent += 1;
      else summary.skipped += 1;
    } catch (err) {
      summary.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      summary.errors.push(`subscription ${row.id}: ${message}`);
    }
  }

  return summary;
}
