"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setAlertMailerSettings, sendTestAlertDigest } from "./actions";

type Settings = {
  enabled: boolean;
  extraRecipients: string[];
  defaultThresholdPct: number;
  skipWhenEmpty: boolean;
};

type Subscriber = { email: string; frequency: string; lastSentAt: string | null };

type Status =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "saved" }
  | { state: "testing" }
  | { state: "tested"; message: string }
  | { state: "error"; message: string };

/**
 * Configurations → Alert digest.
 *
 * Shape follows the conventions the best settings pages converge on (Notion /
 * Slack / Stripe, per the settings-UX survey): grouped by how someone thinks
 * about the feature, inline microcopy under every control explaining what it
 * actually does, and the master off-switch as the first and most obvious
 * action rather than buried at the bottom.
 *
 * Two ideas are lifted directly from Metabase's dashboard subscriptions, the
 * closest analogue in a BI product:
 *   - "Send test now", because SMTP lives in env vars and otherwise the only
 *     way to discover it's misconfigured is for tomorrow's digest to silently
 *     not arrive.
 *   - "Don't send if there aren't results", because an empty digest is noise
 *     and noise is what makes people mute a channel permanently.
 *
 * The SCHEDULE is rendered read-only on purpose. Vercel Cron schedules live in
 * vercel.json and are fixed at build time, and this project's plan permits one
 * invocation per day, so the usual "run hourly and decide in code" workaround
 * is unavailable too. Standard guidance for a control the user genuinely
 * cannot change is to show it, visibly inert, WITH the reason — not to hide it
 * and not to fake it.
 */
export function AlertMailerForm({
  current,
  scheduleLabel,
  approvedDomain,
  subscribers,
}: {
  current: Settings;
  scheduleLabel: string;
  approvedDomain: string;
  subscribers: Subscriber[];
}) {
  const router = useRouter();
  const [settings, setSettings] = useState<Settings>(current);
  const [draftEmail, setDraftEmail] = useState("");
  const [status, setStatus] = useState<Status>({ state: "idle" });

  const dirty = JSON.stringify(settings) !== JSON.stringify(current);
  const busy = status.state === "saving" || status.state === "testing";

  function patch(next: Partial<Settings>) {
    setSettings((s) => ({ ...s, ...next }));
    setStatus({ state: "idle" });
  }

  function addRecipient() {
    const email = draftEmail.trim().toLowerCase();
    if (!email) return;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      setStatus({ state: "error", message: `"${email}" doesn't look like an email address.` });
      return;
    }
    if (settings.extraRecipients.includes(email)) {
      setStatus({ state: "error", message: "That address is already on the list." });
      return;
    }
    patch({ extraRecipients: [...settings.extraRecipients, email] });
    setDraftEmail("");
  }

  async function onSave() {
    setStatus({ state: "saving" });
    try {
      await setAlertMailerSettings(settings);
      setStatus({ state: "saved" });
      router.refresh();
    } catch (err) {
      setStatus({ state: "error", message: err instanceof Error ? err.message : "Save failed." });
    }
  }

  async function onTest() {
    setStatus({ state: "testing" });
    try {
      const res = await sendTestAlertDigest();
      setStatus({
        state: "tested",
        message: res.usedSampleData
          ? `Test sent to ${res.to}. No store is currently below the threshold, so it used one clearly-labelled sample row.`
          : `Test sent to ${res.to} with your real current exceptions.`,
      });
    } catch (err) {
      setStatus({ state: "error", message: err instanceof Error ? err.message : "Test send failed." });
    }
  }

  return (
    <div className="flex flex-col gap-5 border border-line-soft p-4">
      {/* Master switch first — muting must be one obvious action, never buried. */}
      <label className="flex cursor-pointer items-start gap-2.5">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
          disabled={busy}
          className="mt-0.5"
        />
        <span>
          <span className="text-[13px] font-medium text-ink">Send the daily digest</span>
          <span className="mt-0.5 block text-[12px] text-ink-3">
            Off stops every digest immediately, for everyone, without unsubscribing anyone. Individual
            subscriptions are kept and resume when this is switched back on.
          </span>
        </span>
      </label>

      {/* Schedule — inert by necessity, shown with the reason rather than hidden. */}
      <div className="border-l-2 border-line-soft pl-3">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Schedule</div>
        <div className="mt-1 font-mono text-[13px] text-ink">{scheduleLabel}</div>
        <p className="mt-1 max-w-xl text-[12px] text-ink-3">
          Not editable here. The schedule is defined in <code className="font-mono">vercel.json</code> and fixed
          when the app is deployed, and this project&apos;s hosting plan allows one scheduled run per day — so a
          time picker on this page would appear to work and quietly do nothing. Changing it needs a one-line
          code change and a redeploy.
        </p>
      </div>

      {/* Who gets it: opted-in subscribers (read-only) + admin-added extras. */}
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Subscribers</div>
        <p className="mt-1 text-[12px] text-ink-3">
          People who opted in themselves from the Overview page. They control their own subscription — you
          can&apos;t add or remove someone here.
        </p>
        {subscribers.length === 0 ? (
          <p className="mt-2 text-[12.5px] text-ink-3">Nobody is subscribed yet.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1">
            {subscribers.map((s) => (
              <li key={s.email} className="flex items-baseline gap-2 text-[12.5px]">
                <span className="text-ink-2">{s.email}</span>
                <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10.5px] font-semibold uppercase text-ink-3">
                  {s.frequency}
                </span>
                <span className="text-[11px] text-ink-3">
                  {s.lastSentAt ? `last sent ${s.lastSentAt.slice(0, 10)}` : "never sent"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Also send to</div>
        <p className="mt-1 max-w-xl text-[12px] text-ink-3">
          Extra addresses copied on every digest — a shared ops or leadership inbox that doesn&apos;t need a
          Retail BI login of its own. The digest contains store-level sales and discount figures, so treat
          adding an address as sharing that data.
        </p>

        {settings.extraRecipients.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {settings.extraRecipients.map((email) => {
              const external = !email.endsWith(`@${approvedDomain}`);
              return (
                <li
                  key={email}
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] ${
                    external ? "bg-warn-soft text-warn" : "bg-surface-2 text-ink-2"
                  }`}
                  title={external ? `Outside @${approvedDomain}` : undefined}
                >
                  {external && <span aria-hidden>⚠</span>}
                  {email}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => patch({ extraRecipients: settings.extraRecipients.filter((r) => r !== email) })}
                    className="font-bold opacity-60 hover:opacity-100"
                    aria-label={`Remove ${email}`}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {settings.extraRecipients.some((e) => !e.endsWith(`@${approvedDomain}`)) && (
          <p className="mt-2 text-[12px] text-warn">
            One or more addresses are outside <code className="font-mono">@{approvedDomain}</code>. That&apos;s
            allowed, but it sends internal sales data off-domain — worth double-checking.
          </p>
        )}

        <div className="mt-2 flex items-center gap-2">
          <Input
            type="email"
            value={draftEmail}
            disabled={busy}
            onChange={(e) => setDraftEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addRecipient();
              }
            }}
            placeholder={`name@${approvedDomain}`}
            className="w-64"
          />
          <Button type="button" variant="outline" size="sm" disabled={busy || !draftEmail.trim()} onClick={addRecipient}>
            Add
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-6">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Default threshold</span>
          <span className="flex items-center gap-2">
            <Input
              type="number"
              max={0}
              min={-100}
              step={1}
              disabled={busy}
              value={settings.defaultThresholdPct}
              onChange={(e) => patch({ defaultThresholdPct: Number(e.target.value) })}
              className="w-24"
            />
            <span className="text-[12.5px] text-ink-3">% week-over-week</span>
          </span>
          <span className="max-w-xs text-[12px] text-ink-3">
            A store is flagged when its sales fall by more than this. Only applies to subscriptions that
            haven&apos;t set their own.
          </span>
        </label>

        <label className="flex max-w-xs cursor-pointer items-start gap-2.5">
          <input
            type="checkbox"
            checked={settings.skipWhenEmpty}
            onChange={(e) => patch({ skipWhenEmpty: e.target.checked })}
            disabled={busy}
            className="mt-0.5"
          />
          <span>
            <span className="text-[13px] font-medium text-ink">Skip empty digests</span>
            <span className="mt-0.5 block text-[12px] text-ink-3">
              Don&apos;t send anything on days when no store is below the threshold.
            </span>
          </span>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-line-soft pt-4">
        <Button type="button" disabled={!dirty || busy} onClick={onSave}>
          {status.state === "saving" ? "Saving…" : "Save changes"}
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onTest}>
          {status.state === "testing" ? "Sending…" : "Send test to me"}
        </Button>

        {status.state === "saved" && <span className="text-[12.5px] text-good">Saved.</span>}
        {status.state === "tested" && <span className="text-[12.5px] text-good">{status.message}</span>}
        {status.state === "error" && <span className="text-[12.5px] text-crit">{status.message}</span>}
        {dirty && status.state === "idle" && (
          <span className="text-[12.5px] text-ink-3">Unsaved changes.</span>
        )}
      </div>
    </div>
  );
}
