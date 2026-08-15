import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/data/client";

type FootfallStats = { avg_footfall: number | string | null; days_recorded: number };

const bodySchema = z.object({
  store_id: z.string(),
  date: z.string().date(),
  footfall: z.number().int().min(0),
  remarks: z.string().max(500).optional(),
  // Set by the client after the user confirms an outlier warning. The
  // warning itself is advisory — a legitimate spike (festival, campaign,
  // local event) is exactly the kind of day that matters most, so this
  // never hard-rejects, it just requires an explicit second confirmation.
  confirmed_outlier: z.boolean().optional(),
});

// Reference implementation of the { ok, error } contract from
// docs/api-layer-plan.md §8. RLS on ops.ebo_footfall_daily and the
// ops.fn_validate_footfall trigger are the actual enforcement — this handler
// exists to turn their errors into copy the footfall screen expects,
// not to re-implement authorization.
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_body", message: parsed.error.message } },
      { status: 400 }
    );
  }

  const supabase = await createClient();
  const { store_id, date, footfall, remarks, confirmed_outlier } = parsed.data;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthorized", message: "Not signed in." } },
      { status: 401 }
    );
  }

  // Future dates rejected outright — footfall is a count of people who
  // already walked in, so a future entry is always a typo in the date field.
  const today = new Date().toISOString().slice(0, 10);
  if (date > today) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "future_date", message: "Can't enter footfall for a future date." },
      },
      { status: 400 }
    );
  }

  // Outlier check against the store's trailing 28-day average. Only warns
  // when there's a real basis for it — a store with under 7 recorded days
  // has no meaningful "normal" yet, so no warning is raised at all rather
  // than one computed from two data points.
  if (!confirmed_outlier) {
    const { data: stats } = await supabase
      .schema("ops")
      .from<FootfallStats>("vw_footfall_stats")
      .select("avg_footfall, days_recorded")
      .eq("store_id", store_id)
      .maybeSingle();

    const avg = stats?.avg_footfall ? Number(stats.avg_footfall) : null;
    if (avg && (stats?.days_recorded ?? 0) >= 7 && avg > 0) {
      const ratio = footfall / avg;
      if (ratio >= 2 || ratio <= 0.4) {
        return NextResponse.json(
          {
            ok: false,
            error: {
              code: "needs_confirmation",
              message:
                ratio >= 2
                  ? `That's unusually high — this store averages ${Math.round(avg)}/day over the last 28 days. Confirm to save anyway.`
                  : `That's unusually low — this store averages ${Math.round(avg)}/day over the last 28 days. Confirm to save anyway.`,
            },
          },
          { status: 409 }
        );
      }
    }
  }

  const { error } = await supabase
    .schema("ops")
    .from("ebo_footfall_daily")
    .upsert(
      {
        store_id,
        date,
        footfall,
        source: "manual",
        remarks: remarks || null,
        entered_by: user.id,
        updated_by: user.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "store_id,date" }
    );

  if (error) {
    // ops.fn_validate_footfall raises a plain-language exception already
    // ("Footfall (X) cannot be less than the day's Y sale bills..."), so
    // for that specific failure mode the Postgres message is user-facing
    // as-is. An RLS denial (no store grant / wrong role) surfaces as a
    // Postgres permission error — code 42501 — and gets a generic message
    // instead of leaking policy internals.
    const isPermissionDenied = error.code === "42501";
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: isPermissionDenied ? "forbidden" : "footfall_rejected",
          message: isPermissionDenied
            ? "You don't have access to enter footfall for this store."
            : error.message,
        },
      },
      { status: isPermissionDenied ? 403 : 400 }
    );
  }

  return NextResponse.json({ ok: true, data: null });
}
