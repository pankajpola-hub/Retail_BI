import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/data/client";

type EboMonthlyTargetRow = {
  fresh_target_qty: number;
  discounted_target_qty: number;
  updated_at: string;
};

type EboMonthlyTargetUpsertRow = {
  store_id: string;
  period_month: string;
  fresh_target_qty: number;
  discounted_target_qty: number;
  set_by: string;
  updated_at: string;
};

const bodySchema = z.object({
  store_id: z.string(),
  // "YYYY-MM" from <input type="month">, normalised to the 1st below.
  period_month: z.string().regex(/^\d{4}-\d{2}$/),
  fresh_target_qty: z.number().int().min(0),
  discounted_target_qty: z.number().int().min(0),
  // Set by the client only after the user has confirmed the "targets
  // already exist" warning — same two-step pattern as footfall's outlier
  // confirmation in /api/footfall.
  confirmed_overwrite: z.boolean().optional(),
});

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_body", message: parsed.error.message } },
      { status: 400 }
    );
  }

  const supabase = await createClient();
  const { store_id, period_month, fresh_target_qty, discounted_target_qty, confirmed_overwrite } =
    parsed.data;
  const periodDate = `${period_month}-01`;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthorized", message: "Not signed in." } },
      { status: 401 }
    );
  }

  if (!confirmed_overwrite) {
    const { data: existing } = await supabase
      .schema("ops")
      .from<EboMonthlyTargetRow>("ebo_monthly_targets")
      .select("fresh_target_qty, discounted_target_qty, updated_at")
      .eq("store_id", store_id)
      .eq("period_month", periodDate)
      .maybeSingle();

    if (existing) {
      const setDate = new Date(existing.updated_at).toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "Asia/Kolkata",
      });
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "needs_confirmation",
            message: `Targets already exist for this store and month — Fresh ${existing.fresh_target_qty}, Discounted ${existing.discounted_target_qty} (last set ${setDate}). Confirm to overwrite.`,
          },
        },
        { status: 409 }
      );
    }
  }

  const { error } = await supabase
    .schema("ops")
    .from<EboMonthlyTargetUpsertRow>("ebo_monthly_targets")
    .upsert(
      {
        store_id,
        period_month: periodDate,
        fresh_target_qty,
        discounted_target_qty,
        set_by: user.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "store_id,period_month" }
    );

  if (error) {
    // RLS restricts insert/update to ho_admin/super_admin (0020 migration) —
    // any other role hits this as a Postgres permission error, 42501.
    const isPermissionDenied = error.code === "42501";
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: isPermissionDenied ? "forbidden" : "target_save_failed",
          message: isPermissionDenied
            ? "Only HO Admin / Super Admin can set monthly targets."
            : error.message,
        },
      },
      { status: isPermissionDenied ? 403 : 400 }
    );
  }

  return NextResponse.json({ ok: true, data: null });
}
