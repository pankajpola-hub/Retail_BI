import { NextResponse } from "next/server";
import { cronAuthFailure } from "@/lib/cron/auth";
import { createAdminClient } from "@/lib/data/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Rebuilds ops.recon_lines from the already-synced raw_uniware.* tables via
// ops.refresh_recon_from_uniware() (migration 0099). No external Uniware call
// happens here — the uniware-sync cron keeps raw_uniware current; this just
// re-derives the recon view from it. Same cron-auth gate as the other jobs, so
// it can be scheduled (e.g. right after uniware-sync) or triggered manually.
export async function GET(request: Request) {
  const denied = cronAuthFailure(request);
  if (denied) return denied;

  const admin = await createAdminClient();
  const { data, error } = await admin
    .schema("ops")
    .rpc<number>("refresh_recon_from_uniware");

  if (error) {
    return NextResponse.json(
      { ok: false, error: { code: "refresh_failed", message: error.message } },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, rowsBuilt: data ?? null });
}
