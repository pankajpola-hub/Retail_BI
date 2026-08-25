import { NextResponse } from "next/server";
import { createClient as createDataClient } from "@/lib/data/client";
import { cleanupOlderUploads } from "@/lib/erpReports/retention";

const REPORT_TYPES = ["sale", "stock", "scheme", "master"] as const;
type ReportType = (typeof REPORT_TYPES)[number];

/**
 * Step 2 of the direct-to-Storage upload flow (see upload-url/route.ts's
 * header) — the browser calls this AFTER it has already PUT the file
 * straight to Supabase Storage using the signed URL from step 1. This
 * route never sees the file itself, only its already-landed storage path;
 * it does exactly what the tail of the old single-request upload/route.ts
 * did: record the ops.erp_report_uploads row and run keep-latest-only
 * cleanup for report types whose raw_logic table has no upload_id FK to
 * protect (see cleanupOlderUploads' header for why sale/master are safe to
 * clean up immediately but stock/scheme aren't).
 */
export async function POST(request: Request) {
  const supabase = await createDataClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: { code: "unauthorized", message: "Not signed in." } }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const reportType = body?.reportType;
  const fileName = body?.fileName;
  const storagePath = body?.storagePath;

  if (typeof reportType !== "string" || !REPORT_TYPES.includes(reportType as ReportType)) {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_body", message: "reportType must be one of sale, stock, scheme, master." } },
      { status: 400 }
    );
  }
  if (typeof fileName !== "string" || !fileName || typeof storagePath !== "string" || !storagePath) {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_body", message: "fileName and storagePath are required." } },
      { status: 400 }
    );
  }
  // The path must be the one THIS user's own upload-url call produced —
  // never trust a client-supplied path blindly, or a caller could register
  // a row pointing at an object it never actually uploaded (or one it
  // doesn't own). upload-url/route.ts always scopes the path under the
  // caller's own user.id segment.
  if (!storagePath.startsWith(`${reportType}/${user.id}/`)) {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_body", message: "storagePath does not match this upload." } },
      { status: 400 }
    );
  }

  const { data: inserted, error: recordError } = await supabase
    .schema("ops")
    .from<{ id: string }>("erp_report_uploads")
    .insert({ report_type: reportType, file_name: fileName, storage_path: storagePath, uploaded_by: user.id })
    .select("id");
  if (recordError) {
    return NextResponse.json({ ok: false, error: { code: "record_failed", message: recordError.message } }, { status: 400 });
  }

  const newId = inserted?.[0]?.id;
  if (newId && (reportType === "sale" || reportType === "master")) {
    await cleanupOlderUploads(supabase, reportType, newId);
  }

  return NextResponse.json({ ok: true, data: null });
}
