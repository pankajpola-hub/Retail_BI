"use server";

import { z } from "zod";
import { createClient } from "@/lib/data/client";
import { createAdminClient } from "@/lib/data/admin";
import type { AppRole } from "@/lib/auth/roles";
import { ALERT_MAILER_SETTINGS_KEY, getAlertMailerSettings } from "@/lib/alerts/settings";
import { sendAlertDigest } from "@/lib/alerts/mailer";
import { resolveOwnerStoreIds } from "@/lib/exports/scheduledExports";
import { computeSalesTotals, type WeeklyRow } from "@/lib/sales/aggregate";
import { computeStoreExceptions, type StoreException } from "@/lib/sales/exceptions";

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

const freshDiscSourceSchema = z.enum(["discount_ratio", "scheme_lookup"]);

// Same re-check-the-caller pattern as web/app/(admin)/users/actions.ts's
// requireSuperAdminCaller — Server Actions are directly callable regardless
// of whether (configurations)/layout.tsx's requireRole("super_admin") ran.
async function requireSuperAdminCaller(): Promise<string> {
  const supabase = await createClient();
  const {
    data: { user: caller },
  } = await supabase.auth.getUser();
  if (!caller) throw new Error("Not authenticated.");

  const { data: callerProfile } = await supabase
    .schema("core")
    .from<{ role: AppRole }>("profiles")
    .select("role")
    .eq("user_id", caller.id)
    .single();

  if (callerProfile?.role !== "super_admin") {
    throw new Error("Only super_admin can change configurations.");
  }

  return caller.id;
}

/**
 * Writes core.app_settings.fresh_disc_classification_source (0057/0058) via
 * the service-role client — core.app_settings has no authenticated write
 * policy, same posture as core.user_page_overrides. Every role's Targets
 * tracker and audit report read this setting, so changing it changes
 * numbers already on screen for everyone, not just the admin who set it.
 */
const alertMailerSchema = z.object({
  enabled: z.boolean(),
  extraRecipients: z.array(z.string().email("That doesn't look like an email address.")).max(20),
  defaultThresholdPct: z.number().min(-100).max(0),
  skipWhenEmpty: z.boolean(),
});

/**
 * Writes the alert-digest settings to core.app_settings (key `alert_mailer`).
 * No migration needed — app_settings is free-text-keyed with a jsonb value
 * precisely so a new setting never requires one (see 0057's comment).
 *
 * Upsert rather than update: unlike fresh_disc_classification_source, this key
 * is NOT seeded by a migration, so the first save has no row to update.
 */
export async function setAlertMailerSettings(input: unknown): Promise<void> {
  const callerId = await requireSuperAdminCaller();
  const parsed = alertMailerSchema.parse(input);

  const admin = await createAdminClient();
  const { error } = await admin
    .schema("core")
    .from<{ key: string; value: unknown; updated_by: string; updated_at: string }>("app_settings")
    .upsert(
      {
        key: ALERT_MAILER_SETTINGS_KEY,
        value: parsed,
        updated_by: callerId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" }
    );

  if (error) throw new Error(error.message);
}

/**
 * Sends the digest immediately to the signed-in admin only — Metabase's
 * "Send now" button, and the single most useful affordance for an email
 * feature: SMTP config lives in env vars, so without this the only way to
 * discover it's broken is to wait for tomorrow's cron and notice nothing
 * arrived.
 *
 * Deliberately sends ONLY to the caller, never to the configured recipient
 * list — a test that mails the whole leadership team is not a test.
 *
 * Uses real exception data when there is any, and falls back to a clearly
 * labelled sample row when there isn't, so the button still proves the
 * transport works on a day when no store breached the threshold.
 */
export async function sendTestAlertDigest(): Promise<{ to: string; usedSampleData: boolean }> {
  await requireSuperAdminCaller();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) throw new Error("Your account has no email address to send a test to.");

  const admin = await createAdminClient();

  const now = new Date();
  const to = isoDate(now);
  const from = new Date(now);
  from.setDate(from.getDate() - 27);
  const weeklyStart = new Date(from);
  weeklyStart.setDate(weeklyStart.getDate() - 7);

  const settings = await getAlertMailerSettings(admin);
  const storeIds = await resolveOwnerStoreIds(admin, user.id);

  let exceptions: StoreException[] = [];
  if (storeIds.length > 0) {
    const { data: stores } = await admin
      .schema("core")
      .from<{ store_id: string; store_name: string }>("stores")
      .select("store_id, store_name");
    const storeNames = new Map((stores ?? []).map((s) => [s.store_id, s.store_name]));

    const { data: weeks } = await admin
      .schema("sales")
      .from<WeeklyRow>("vw_ebo_sales_weekly")
      .select("*")
      .in("store_id", storeIds)
      .gte("week_start", isoDate(weeklyStart))
      .lte("week_start", to);

    const { weekRows, storesInView } = computeSalesTotals(weeks, isoDate(from));
    exceptions = computeStoreExceptions(weekRows, storesInView, storeNames, settings.defaultThresholdPct);
  }

  const usedSampleData = exceptions.length === 0;
  if (usedSampleData) {
    exceptions = [{ storeId: "SAMPLE", name: "Sample Store (test data)", net: 0, netChangePct: -100 } as StoreException];
  }

  await sendAlertDigest(user.email, exceptions, { subjectPrefix: "[TEST]" });
  return { to: user.email, usedSampleData };
}

export async function setFreshDiscClassificationSource(source: string): Promise<void> {
  const callerId = await requireSuperAdminCaller();
  const parsed = freshDiscSourceSchema.parse(source);

  const admin = await createAdminClient();
  const { error } = await admin
    .schema("core")
    .from<{ key: string; value: unknown; updated_by: string }>("app_settings")
    .update({ key: "fresh_disc_classification_source", value: { source: parsed }, updated_by: callerId })
    .eq("key", "fresh_disc_classification_source");

  if (error) throw new Error(error.message);
}
