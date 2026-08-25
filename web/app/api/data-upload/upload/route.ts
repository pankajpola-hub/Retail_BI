import { NextResponse } from "next/server";
import { createClient as createDataClient } from "@/lib/data/client";
import { saveObjectFile } from "@/lib/storage/supabase";
import { cleanupOlderUploads } from "@/lib/erpReports/retention";

// Without this, Vercel's default function duration ceiling (well under 60s)
// applies — a file upload does two full network hops (browser -> this
// function -> Supabase Storage), and a multi-MB report on a slow
// connection can plausibly exceed that default, killing the function
// mid-upload with no clear client-side error (the browser's fetch() just
// hangs until it eventually errors). 60 is the Hobby-plan ceiling itself
// (see api/cron/uniware-sync/route.ts's own note on this exact limit) —
// can't ask for more without a plan upgrade.
export const maxDuration = 60;

const MAX_BYTES = 20 * 1024 * 1024; // 20MB — ERP report exports run larger than the incentive-target sheets
const ALLOWED_TYPES = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-excel", // .xls
];
const REPORT_TYPES = ["sale", "stock", "scheme", "master"] as const;
type ReportType = (typeof REPORT_TYPES)[number];

/**
 * Offline-mode intake for the three reports pulled by hand from Logic ERP
 * (Sale/Stock/Scheme) while the live SQL Server connector isn't reachable —
 * see migration 0022's header. Upload-only, same as the incentive-target
 * import: stores the file and logs that it arrived, doesn't parse it.
 */
export async function POST(request: Request) {
  const supabase = await createDataClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: { code: "unauthorized", message: "Not signed in." } }, { status: 401 });
  }

  const formData = await request.formData();
  const file = formData.get("file");
  const reportType = formData.get("report_type");

  if (typeof reportType !== "string" || !REPORT_TYPES.includes(reportType as ReportType)) {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_body", message: "report_type must be one of sale, stock, scheme, master." } },
      { status: 400 }
    );
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: { code: "invalid_body", message: "No file provided." } }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ ok: false, error: { code: "file_too_large", message: "File must be under 20MB." } }, { status: 400 });
  }
  if (!ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_type", message: "Only .xlsx or .xls files are accepted." } },
      { status: 400 }
    );
  }

  const path = `${reportType}/${user.id}/${Date.now()}-${file.name}`;

  try {
    await saveObjectFile("erp-reports", path, file);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: { code: "upload_failed", message: err instanceof Error ? err.message : "File write failed." } },
      { status: 500 }
    );
  }

  const { data: inserted, error: recordError } = await supabase
    .schema("ops")
    .from<{ id: string }>("erp_report_uploads")
    .insert({ report_type: reportType, file_name: file.name, storage_path: path, uploaded_by: user.id })
    .select("id");
  if (recordError) {
    return NextResponse.json({ ok: false, error: { code: "record_failed", message: recordError.message } }, { status: 400 });
  }

  // "Always keep the latest file only." Safe to clean up right here ONLY for
  // "sale" — raw_logic.sales_transactions has no upload_id column at all
  // (sale data accumulates, never "replaced"), so an old sale upload row is
  // never referenced by anything else. "stock"/"scheme" are different: their
  // snapshot tables have an upload_id FK, and the OLD upload row is still
  // that live snapshot's owner until a NEW upload is actually PROCESSED —
  // deleting it here, before processing, hits that FK constraint and fails
  // (see cleanupOlderUploads' header). Their cleanup happens in the commit
  // route instead, after a successful process.
  //
  // "master" behaves like "sale" here, for the same structural reason:
  // raw_logic.item_master (migration 0054) has NO upload_id FK — it records
  // provenance as plain source_file text precisely so retention can delete an
  // old upload row without hitting a constraint. And a stale item master is
  // never wanted: the newest attribute list is the only one that should be
  // re-processable, so keep-latest-only applies from the moment it lands.
  const newId = inserted?.[0]?.id;
  if (newId && (reportType === "sale" || reportType === "master")) {
    await cleanupOlderUploads(supabase, reportType, newId);
  }

  return NextResponse.json({ ok: true, data: null });
}
