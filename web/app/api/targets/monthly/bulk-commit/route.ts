import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/data/client";

type EboMonthlyTargetUpsertRow = {
  store_id: string;
  period_month: string;
  fresh_target_qty: number;
  discounted_target_qty: number;
  set_by: string;
  updated_at: string;
};

const bodySchema = z.object({
  rows: z
    .array(
      z.object({
        storeId: z.string(),
        month: z.string().regex(/^\d{4}-\d{2}$/),
        freshTarget: z.number().int().min(0),
        discountedTarget: z.number().int().min(0),
      })
    )
    .min(1)
    // Upper bound on the batch (audit B-14: .min(1) with no .max() let a
    // single request carry an arbitrarily large upsert payload, and there
    // is no rate limiting anywhere in app/api to fall back on).
    //
    // Sizing: a row here is one (store, month) pair. The network is ~30
    // stores, and parseMonthlyTargetsWorkbook reads one row per store-month
    // out of the uploaded sheet with no multiplier — so a realistic upload
    // is tens of rows, and even an unusually wide backfill (100 stores x 36
    // months = 3,600) stays under this. 5,000 leaves clear headroom above
    // any legitimate use while capping the payload at something a single
    // request can sanely upsert.
    .max(5000),
});

// Step 3 of validate → preview → commit. Only ever called with rows the
// client already showed the admin in the /bulk-preview review table — this
// route re-validates the shape but trusts storeId/month resolution already
// done there (RLS is still the real gate on the write itself).
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_body", message: parsed.error.message } },
      { status: 400 }
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: { code: "unauthorized", message: "Not signed in." } }, { status: 401 });
  }

  const payload = parsed.data.rows.map((r) => ({
    store_id: r.storeId,
    period_month: `${r.month}-01`,
    fresh_target_qty: r.freshTarget,
    discounted_target_qty: r.discountedTarget,
    set_by: user.id,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase
    .schema("ops")
    .from<EboMonthlyTargetUpsertRow>("ebo_monthly_targets")
    .upsert(payload, { onConflict: "store_id,period_month" });

  if (error) {
    const isPermissionDenied = error.code === "42501";
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: isPermissionDenied ? "forbidden" : "bulk_save_failed",
          message: isPermissionDenied
            ? "Only HO Admin / Super Admin can set monthly targets."
            : error.message,
        },
      },
      { status: isPermissionDenied ? 403 : 400 }
    );
  }

  return NextResponse.json({ ok: true, data: { count: payload.length } });
}
