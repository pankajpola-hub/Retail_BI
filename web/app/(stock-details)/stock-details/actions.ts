"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/data/client";
import type { AppRole } from "@/lib/auth/roles";

const capacityValueSchema = z.object({
  gender: z.enum(["FEMALE", "MALE"]),
  age_segment: z.enum(["Baby", "Kids"]),
  base_capacity: z.number().int().min(0),
  // null = "use the app-wide default" (110% buffer / 35% fresh — see
  // migration 0031 and DEFAULT_BUFFER_PCT/DEFAULT_FRESH_PCT in
  // lib/stockDetails/aggregate.ts). Only a non-null value overrides it.
  buffer_pct: z.number().positive().nullable(),
  fresh_pct: z.number().min(0).max(100).nullable(),
});

const setStoreCapacitySchema = z.object({
  store_id: z.string().min(1),
  values: z.array(capacityValueSchema).length(4),
});

/**
 * Upserts all 4 (gender x age_segment) base-capacity rows for one store in a
 * single call. Restricted to ho_admin/super_admin.
 *
 * Same defense-in-depth pattern as app/(admin)/users/actions.ts's
 * inviteUser/resetUserPassword: the (stock-details) layout's
 * requireRole("ho_admin", "super_admin") already gates the whole page, but
 * Server Actions are directly callable regardless of which layout rendered
 * the client that called them, so the caller's role is re-checked here
 * independently before any write is attempted. The regular (RLS-respecting)
 * client is used, not the service-role admin client — the RLS write
 * policies on ops.stock_display_capacity (migration 0026) enforce the same
 * ho_admin/super_admin restriction a second time at the database layer, so
 * this check and that policy are two independent gates on the same rule,
 * not one gate duplicated.
 */
export async function setStoreDisplayCapacity(input: z.infer<typeof setStoreCapacitySchema>) {
  const { store_id, values } = setStoreCapacitySchema.parse(input);

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

  if (callerProfile?.role !== "ho_admin" && callerProfile?.role !== "super_admin") {
    throw new Error("Only HO Admin / Super Admin can edit display capacity.");
  }

  const { error } = await supabase
    .schema("ops")
    .from("stock_display_capacity")
    .upsert(
      values.map((v) => ({
        store_id,
        gender: v.gender,
        age_segment: v.age_segment,
        base_capacity: v.base_capacity,
        buffer_pct: v.buffer_pct,
        fresh_pct: v.fresh_pct,
        updated_by: caller.id,
      })),
      { onConflict: "store_id,gender,age_segment" }
    );

  if (error) throw new Error(error.message);

  revalidatePath("/stock-details");
}
