"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/data/client";
import type { DataClient } from "@/lib/data/client";

/**
 * Threshold-alerts CRUD — deliberately thin, same shape as
 * lib/exports/actions.ts: ops.alert_subscriptions is owner-only RLS
 * (migration 0072's alert_subscriptions_owner_all), so these call the
 * caller's own RLS-scoped client, never the admin client. One row per
 * user (owner_id unique) — this is a toggle, not a CRUD list.
 */

export type Frequency = "daily" | "weekly";
const FREQUENCIES: Frequency[] = ["daily", "weekly"];

export type AlertSubscriptionSummary = {
  frequency: Frequency;
  thresholdPct: number;
  lastRunAt: string | null;
  lastSentAt: string | null;
};

type AlertSubscriptionRow = {
  frequency: Frequency;
  threshold_pct: number | string;
  last_run_at: string | null;
  last_sent_at: string | null;
};

async function requireCallerId(supabase: DataClient): Promise<string> {
  const {
    data: { user: caller },
  } = await supabase.auth.getUser();
  if (!caller) throw new Error("Not authenticated.");
  return caller.id;
}

/** RLS (alert_subscriptions_owner_all) already narrows this to owner_id = caller — null means not subscribed. */
export async function getMyAlertSubscription(): Promise<AlertSubscriptionSummary | null> {
  const supabase = await createClient();
  await requireCallerId(supabase);

  const { data, error } = await supabase
    .schema("ops")
    .from<AlertSubscriptionRow>("alert_subscriptions")
    .select("frequency, threshold_pct, last_run_at, last_sent_at")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;

  return {
    frequency: data.frequency,
    thresholdPct: Number(data.threshold_pct),
    lastRunAt: data.last_run_at,
    lastSentAt: data.last_sent_at,
  };
}

export async function subscribeToAlerts(frequency: Frequency): Promise<void> {
  const supabase = await createClient();
  const ownerId = await requireCallerId(supabase);

  if (!FREQUENCIES.includes(frequency)) throw new Error("Unknown frequency.");

  // Upsert on owner_id (unique) — resubscribing just changes the frequency,
  // same "one row per user" posture the migration's unique constraint
  // enforces at the DB level too.
  const { error } = await supabase
    .schema("ops")
    .from("alert_subscriptions")
    .upsert({ owner_id: ownerId, frequency }, { onConflict: "owner_id" });
  if (error) throw new Error(error.message);
  revalidatePath("/network");
}

export async function unsubscribeFromAlerts(): Promise<void> {
  const supabase = await createClient();
  const ownerId = await requireCallerId(supabase);

  // Explicit .eq() rather than relying on RLS alone to scope an unfiltered
  // delete — same defensive posture as deleteScheduledExport's .eq("id", id).
  const { error } = await supabase.schema("ops").from("alert_subscriptions").delete().eq("owner_id", ownerId);
  if (error) throw new Error(error.message);
  revalidatePath("/network");
}
