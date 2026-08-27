import { NextResponse } from "next/server";
import { createClient as createDataClient } from "@/lib/data/client";
import { saveObjectFile, removeObjectFile } from "@/lib/storage/supabase";
import { roleFailure } from "@/app/api/_shared/requireRole";
import { TARGETS_MAX_BYTES, TARGETS_ALLOWED_TYPES } from "@/app/api/_shared/targetsUploadLimits";

/**
 * Upload-only, per the request: store the file and record that it arrived.
 * No parsing here — when target parsing gets built, follow the
 * validate -> preview -> commit pattern from the marketing CSV import
 * (docs/api-layer-plan.md §4), not a direct parse-on-upload.
 *
 * Order of operations matters here (audit B-06). saveObjectFile uses the
 * SERVICE-ROLE client (lib/storage/supabase.ts:50), so RLS never sees the
 * storage write — the only thing RLS stopped was the DB row afterwards
 * (ops.incentive_target_imports' incentive_target_imports_rw policy is
 * ho_admin/super_admin). A non-admin's request therefore wrote the object
 * first, got a 400 record_failed second, and left the object behind
 * forever. Both halves are fixed: the role check runs BEFORE the write,
 * and the write is undone if the row still fails.
 */
export async function POST(request: Request) {
  const supabase = await createDataClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: { code: "unauthorized", message: "Not signed in." } }, { status: 401 });
  }

  const denied = await roleFailure(supabase, user.id, "Only HO Admin / Super Admin can upload incentive targets.");
  if (denied) return denied;

  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: { code: "invalid_body", message: "No file provided." } }, { status: 400 });
  }
  if (file.size > TARGETS_MAX_BYTES) {
    return NextResponse.json({ ok: false, error: { code: "file_too_large", message: "File must be under 10MB." } }, { status: 400 });
  }
  if (!TARGETS_ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_type", message: "Only .xlsx or .xls files are accepted." } },
      { status: 400 }
    );
  }

  const path = `${user.id}/${Date.now()}-${file.name}`;

  try {
    await saveObjectFile("incentive-targets", path, file);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: { code: "upload_failed", message: err instanceof Error ? err.message : "File write failed." } },
      { status: 500 }
    );
  }

  const { error: recordError } = await supabase
    .schema("ops")
    .from("incentive_target_imports")
    .insert({ file_name: file.name, storage_path: path, uploaded_by: user.id });
  if (recordError) {
    // Defence in depth: the role check above should already have stopped
    // every caller who would fail this insert, but if the row is rejected
    // for any reason (RLS, a constraint, a future policy change) the object
    // we just wrote has no owning row and nothing would ever reference or
    // clean it up. Best-effort — a failed cleanup must not mask the real
    // error, so it is logged rather than thrown.
    try {
      await removeObjectFile("incentive-targets", path);
    } catch (cleanupErr) {
      console.error("[targets/upload] orphaned object cleanup failed", { path, cleanupErr });
    }
    return NextResponse.json({ ok: false, error: { code: "record_failed", message: recordError.message } }, { status: 400 });
  }

  return NextResponse.json({ ok: true, data: null });
}
