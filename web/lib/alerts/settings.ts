import "server-only";
import type { DataClient } from "@/lib/data/client";

/**
 * Admin-editable settings for the threshold-alert digest, stored in
 * core.app_settings (0057) under the key below. No migration needed —
 * app_settings is deliberately free-text-keyed with a jsonb value precisely
 * so a new setting never requires one (see that table's comment).
 *
 * WHAT IS AND ISN'T CONFIGURABLE, and why:
 *
 *   enabled / extraRecipients / defaultThresholdPct  -> real, take effect on
 *   the next cron run.
 *
 *   The SEND TIME is NOT here, and deliberately so. Vercel Cron schedules
 *   live in vercel.json and are fixed at build time; nothing read from a
 *   database can move them. Worse, this project is on Vercel's Hobby plan,
 *   where a cron may only be invoked ONCE PER DAY — so the usual workaround
 *   ("run hourly, let the app decide whether it's time") is not available
 *   either. Storing a send-time here would produce a control that looks like
 *   it works and silently does nothing, which is the one thing this codebase
 *   has consistently refused to ship. The schedule is surfaced read-only on
 *   the Configurations page instead, converted to IST so it is at least
 *   discoverable. See ALERT_CRON_UTC_HOUR below.
 */
export const ALERT_MAILER_SETTINGS_KEY = "alert_mailer";

/**
 * Mirrors vercel.json's `/api/cron/alerts` schedule ("0 7 * * *"). Vercel Cron
 * runs in UTC, which is not obvious from the app: 07:00 UTC is 12:30 PM IST,
 * so the "daily digest" lands mid-afternoon rather than in the morning as the
 * wording implies. Kept here as a named constant so the Configurations page
 * can show the real time rather than leaving people to guess.
 *
 * If this changes in vercel.json, change it here too — there is no runtime
 * link between the two.
 */
export const ALERT_CRON_UTC_HOUR = 7;

export type AlertMailerSettings = {
  /** Master switch. When false, runDueAlerts sends nothing at all. */
  enabled: boolean;
  /**
   * Addresses that receive EVERY digest, on top of each subscriber's own
   * account email. Lets a shared ops/leadership inbox be copied without
   * needing a Retail BI login of its own — previously impossible, since the
   * only recipient was the subscription owner's own auth email.
   */
  extraRecipients: string[];
  /**
   * Fallback threshold for subscriptions that don't set their own. Negative:
   * -20 means "flag a store down more than 20% week-over-week".
   */
  defaultThresholdPct: number;
  /**
   * Metabase's "Don't send if there aren't results" — an empty digest is
   * noise, and noise is what makes people mute an alert channel entirely.
   * runDueAlerts already skips per-subscription when there are no exceptions;
   * this makes the same rule explicit and visible to the admin.
   */
  skipWhenEmpty: boolean;
};

export const DEFAULT_ALERT_MAILER_SETTINGS: AlertMailerSettings = {
  enabled: true,
  extraRecipients: [],
  defaultThresholdPct: -20,
  skipWhenEmpty: true,
};

/**
 * Addresses outside this domain are flagged in the admin UI before saving.
 * A digest carries store-level sales and discount figures, so adding a
 * recipient is a data-egress decision, not just a preference — approved-domain
 * restriction is the standard control for outbound recipients (Metabase Pro,
 * Google Workspace and Genesys all ship a version of it).
 *
 * Deliberately a WARNING, not a hard block: there are legitimate reasons to
 * mail an auditor or a consultant, and silently refusing would be worse than
 * making the choice visible.
 */
export const APPROVED_RECIPIENT_DOMAIN = "peppermint.in";

export function isExternalRecipient(email: string): boolean {
  return !email.trim().toLowerCase().endsWith(`@${APPROVED_RECIPIENT_DOMAIN}`);
}

/** Narrow unknown jsonb to the settings shape, falling back per-field. */
export function parseAlertMailerSettings(value: unknown): AlertMailerSettings {
  const v = (value ?? {}) as Partial<AlertMailerSettings>;
  const recipients = Array.isArray(v.extraRecipients)
    ? v.extraRecipients.filter((r): r is string => typeof r === "string" && r.includes("@"))
    : [];
  const threshold = typeof v.defaultThresholdPct === "number" && Number.isFinite(v.defaultThresholdPct)
    ? v.defaultThresholdPct
    : DEFAULT_ALERT_MAILER_SETTINGS.defaultThresholdPct;
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : DEFAULT_ALERT_MAILER_SETTINGS.enabled,
    extraRecipients: recipients,
    defaultThresholdPct: threshold,
    skipWhenEmpty: typeof v.skipWhenEmpty === "boolean" ? v.skipWhenEmpty : DEFAULT_ALERT_MAILER_SETTINGS.skipWhenEmpty,
  };
}

/**
 * Reads the settings row. Returns defaults when the key has never been
 * written, so the digest keeps working exactly as it did before this setting
 * existed rather than silently switching off.
 */
export async function getAlertMailerSettings(client: DataClient): Promise<AlertMailerSettings> {
  const { data } = await client
    .schema("core")
    .from<{ key: string; value: unknown }>("app_settings")
    .select("key, value")
    .eq("key", ALERT_MAILER_SETTINGS_KEY)
    .maybeSingle();
  if (!data) return DEFAULT_ALERT_MAILER_SETTINGS;
  return parseAlertMailerSettings(data.value);
}

/** "12:30 PM IST" for a given UTC hour — IST is UTC+5:30, so hours shift by 5 and minutes by 30. */
export function utcHourToIstLabel(utcHour: number): string {
  const totalMinutes = (utcHour * 60 + 5 * 60 + 30) % (24 * 60);
  const h24 = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  const suffix = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix} IST`;
}
