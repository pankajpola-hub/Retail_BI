import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/data/client";

// Saves one ops.daily_target_remarks row (0032) — the /targets daily
// tracker's per-day "why did the sale move" note. No role check beyond
// "signed in" here: /targets itself is gated by requirePageAccess("targets")
// (web/lib/auth/roles.ts, widened in 0032 to include ebo_manager), and
// ops.daily_target_remarks' own RLS (store_id = any(core.fn_user_store_ids()))
// is the real backstop that stops anyone — including ho_admin/super_admin —
// from writing a remark against a store they don't have access to. Same
// division of labor as /api/targets/monthly (page-level gate + RLS, not a
// role list duplicated in this route).

type RemarkUpsertRow = {
  store_id: string;
  date: string;
  bucket: "fresh" | "discounted";
  remark_text: string | null;
  updated_by: string;
};

const bodySchema = z.object({
  store_id: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  bucket: z.enum(["fresh", "discounted"]),
  remark_text: z.string().max(2000),
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
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthorized", message: "Not signed in." } },
      { status: 401 }
    );
  }

  const { store_id, date, bucket, remark_text } = parsed.data;
  const { error } = await supabase
    .schema("ops")
    .from<RemarkUpsertRow>("daily_target_remarks")
    .upsert(
      {
        store_id,
        date,
        bucket,
        remark_text: remark_text.trim() === "" ? null : remark_text,
        updated_by: user.id,
      },
      { onConflict: "store_id,date,bucket" }
    );

  if (error) {
    // RLS (ops.daily_target_remarks, 0032) restricts writes to stores the
    // caller has access to via core.fn_user_store_ids() — any other case
    // hits this as a Postgres permission error, 42501.
    const isPermissionDenied = error.code === "42501";
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: isPermissionDenied ? "forbidden" : "remark_save_failed",
          message: isPermissionDenied
            ? "You don't have access to write remarks for this store."
            : error.message,
        },
      },
      { status: isPermissionDenied ? 403 : 400 }
    );
  }

  return NextResponse.json({ ok: true, data: null });
}
