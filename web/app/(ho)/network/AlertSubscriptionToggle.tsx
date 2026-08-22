"use client";

import { useState, useTransition } from "react";
import { subscribeToAlerts, unsubscribeFromAlerts, type AlertSubscriptionSummary, type Frequency } from "@/lib/alerts/actions";

/**
 * Threshold-alerts toggle, colocated with the "Needs attention" panel it's
 * about (same placement principle as ScheduledExportsPanel living inside
 * the Workspace page, not a new nav item). v1 has no rule-authoring UI —
 * subscribing just opts into an email digest of whatever this exact panel
 * already shows, on the chosen cadence, per the plan's deliberately narrow
 * scope.
 */
export function AlertSubscriptionToggle({ initial }: { initial: AlertSubscriptionSummary | null }) {
  const [subscription, setSubscription] = useState(initial);
  const [frequency, setFrequency] = useState<Frequency>(initial?.frequency ?? "daily");
  const [isPending, startTransition] = useTransition();

  function handleSubscribe() {
    startTransition(async () => {
      await subscribeToAlerts(frequency);
      setSubscription({ frequency, thresholdPct: subscription?.thresholdPct ?? -10, lastRunAt: subscription?.lastRunAt ?? null, lastSentAt: subscription?.lastSentAt ?? null });
    });
  }

  function handleUnsubscribe() {
    startTransition(async () => {
      await unsubscribeFromAlerts();
      setSubscription(null);
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line-soft px-3 py-2 text-[12px]">
      {subscription ? (
        <>
          <span className="text-ink-2">
            Emailing you a <strong>{subscription.frequency}</strong> digest of this list
            {subscription.lastSentAt ? ` · last sent ${new Date(subscription.lastSentAt).toLocaleString()}` : " · not sent yet"}
          </span>
          <button
            type="button"
            disabled={isPending}
            onClick={handleUnsubscribe}
            className="ml-auto text-accent hover:underline disabled:opacity-50"
          >
            Unsubscribe
          </button>
        </>
      ) : (
        <>
          <span className="text-ink-3">Email me when a store shows up here:</span>
          <select
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as Frequency)}
            className="min-h-[28px] rounded-md border border-line bg-surface px-2 py-1 text-[12px] text-ink-2"
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
          <button
            type="button"
            disabled={isPending}
            onClick={handleSubscribe}
            className="ml-auto text-accent hover:underline disabled:opacity-50"
          >
            Subscribe
          </button>
        </>
      )}
    </div>
  );
}
