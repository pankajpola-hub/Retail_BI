import { requirePageAccess } from "@/lib/auth/roles";
import { createClient } from "@/lib/data/client";
import { createAdminClient } from "@/lib/data/admin";
import { createAdminClient as createRawAdminClient } from "@/lib/supabase/admin";
import { getDict } from "@/lib/i18n/server";
import { FreshDiscSourceForm } from "./fresh-disc-source-form";
import { AlertMailerForm } from "./alert-mailer-form";
import {
  ALERT_CRON_UTC_HOUR,
  APPROVED_RECIPIENT_DOMAIN,
  getAlertMailerSettings,
  utcHourToIstLabel,
} from "@/lib/alerts/settings";

export const dynamic = "force-dynamic";

type AppSettingRow = { key: string; value: { source?: string } };

export default async function ConfigurationsPage() {
  // requirePageAccess (migration 0035) layers a per-user override on top of
  // the role default — (configurations)/layout.tsx's requireRole gate is
  // coarse, same reasoning as (admin)/integrations/page.tsx.
  await requirePageAccess("configurations");
  const t = await getDict();

  // core.app_settings grants SELECT to authenticated (0057) — every role
  // that ends up reading the Fresh/Disc setting via the tracker function
  // needs that, so the admin page reads it the same ordinary way, no admin
  // client needed for the read side.
  const supabase = await createClient();
  const { data: setting } = await supabase
    .schema("core")
    .from<AppSettingRow>("app_settings")
    .select("key, value")
    .eq("key", "fresh_disc_classification_source")
    .maybeSingle();

  const currentSource = setting?.value?.source === "scheme_lookup" ? "scheme_lookup" : "discount_ratio";

  // Alert-digest settings + who is currently subscribed. Subscriber emails
  // live in auth.users, not core.profiles, so resolving them needs the admin
  // client — same pattern the Users page uses. Non-fatal: the section still
  // renders (without the subscriber list) if this fails.
  const admin = await createAdminClient();
  const mailerSettings = await getAlertMailerSettings(admin);

  let subscribers: { email: string; frequency: string; lastSentAt: string | null }[] = [];
  try {
    const { data: subs } = await admin
      .schema("ops")
      .from<{ owner_id: string; frequency: string; last_sent_at: string | null }>("alert_subscriptions")
      .select("owner_id, frequency, last_sent_at");
    if (subs && subs.length > 0) {
      const rawAdmin = createRawAdminClient();
      const { data: authUsers } = await rawAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      const emailById = new Map((authUsers?.users ?? []).map((u) => [u.id, u.email ?? ""]));
      subscribers = subs
        .map((s) => ({
          email: emailById.get(s.owner_id) || "(unknown account)",
          frequency: s.frequency,
          lastSentAt: s.last_sent_at,
        }))
        .sort((a, b) => a.email.localeCompare(b.email));
    }
  } catch {
    // leave subscribers empty
  }

  const scheduleLabel = `Daily at ${utcHourToIstLabel(ALERT_CRON_UTC_HOUR)}  ·  ${String(ALERT_CRON_UTC_HOUR).padStart(2, "0")}:00 UTC`;

  return (
    <main className="py-6">
      <h1 className="font-serif text-2xl">{t.configurationsTitle}</h1>
      <p className="mt-1 max-w-2xl text-[12.5px] text-ink-3">{t.configurationsSubtitle}</p>

      <div className="mt-6 max-w-xl">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">{t.configFreshDiscSourceLabel}</h2>
        <p className="mt-1 text-[12.5px] text-ink-3">{t.configFreshDiscSourceHint}</p>
        <div className="mt-3">
          <FreshDiscSourceForm
            current={currentSource}
            labels={{
              ratio: t.configFreshDiscSourceRatio,
              ratioHint: t.configFreshDiscSourceRatioHint,
              scheme: t.configFreshDiscSourceScheme,
              schemeHint: t.configFreshDiscSourceSchemeHint,
              save: t.configSaveButton,
              saved: t.configSavedNotice,
            }}
          />
        </div>
      </div>

      <div className="mt-10 max-w-2xl">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Alert digest</h2>
        <p className="mt-1 text-[12.5px] text-ink-3">
          The &ldquo;Needs attention&rdquo; email — which stores fell furthest week-over-week. Sent to whoever
          opted in from the Overview page, plus any extra addresses set here.
        </p>
        <div className="mt-3">
          <AlertMailerForm
            current={mailerSettings}
            scheduleLabel={scheduleLabel}
            approvedDomain={APPROVED_RECIPIENT_DOMAIN}
            subscribers={subscribers}
          />
        </div>
      </div>
    </main>
  );
}
