import { NextResponse } from "next/server";
import { createClient as createDataClient } from "@/lib/data/client";
import { saveObjectFile } from "@/lib/storage/supabase";

const MAX_BYTES = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-excel", // .xls
];

/**
 * Upload-only, per the request: store the file and record that it arrived.
 * No parsing here — when target parsing gets built, follow the
 * validate -> preview -> commit pattern from the marketing CSV import
 * (docs/api-layer-plan.md §4), not a direct parse-on-upload.
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

  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: { code: "invalid_body", message: "No file provided." } }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ ok: false, error: { code: "file_too_large", message: "File must be under 10MB." } }, { status: 400 });
  }
  if (!ALLOWED_TYPES.includes(file.type)) {
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
    return NextResponse.json({ ok: false, error: { code: "record_failed", message: recordError.message } }, { status: 400 });
  }

  return NextResponse.json({ ok: true, data: null });
}
