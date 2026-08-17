"use server";

import { z } from "zod";
import { createClient } from "@/lib/data/client";
import { createAdminClient } from "@/lib/data/admin";
import type { AppRole } from "@/lib/auth/roles";

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
