import { NextResponse } from "next/server";
import { createClient as createDataClient } from "@/lib/data/client";
import { createUploadUrl } from "@/lib/storage/supabase";
import { roleFailure } from "@/app/api/_shared/requireRole";

// 50MB — raised from 20MB (2026-08-25) after a multi-year merged Sale
// report (all FY sheets combined) hit the old cap. 50MB is the real
// ceiling here, not an arbitrary round number: confirmed live by direct
// PUT tests against this project's Storage — 50MB succeeds, 55MB fails
// with a 413 "EntityTooLarge" from Supabase itself (a project-wide
// Storage setting, not something this app's own code enforces or can
// override; the bucket's own file_size_limit is null, i.e. "use the
// project default"). Raising this further needs a Supabase project
// settings change (Storage size limit), not a code change.
const MAX_BYTES = 50 * 1024 * 1024;
const ALLOWED_TYPES = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-excel", // .xls
];
const REPORT_TYPES = ["sale", "stock", "scheme", "master", "channel_summary"] as const;
type ReportType = (typeof REPORT_TYPES)[number];

/**
 * Step 1 of the direct-to-Storage upload flow (2026-08-25, replacing the
 * old single-request upload/route.ts). Issues a signed upload URL the
 * BROWSER then PUTs the file to directly — the file's bytes never pass
 * through this or any other Next.js function, which is the whole point:
 * Vercel Serverless Functions have a hard ~4.5MB request-body ceiling (a
 * platform limit, not something maxDuration or streaming around
 * request.formData() can raise). A master/sale/stock ERP report routinely
 * exceeds that; confirmed live as an "unreadable response" (an HTML
 * platform error page, not this route's JSON) on a master upload through
 * the old proxy-through-our-function path.
 *
 * File size/type here are the CLIENT's own claims (fileSize/contentType in
 * the request body, not actual bytes we've seen) — a soft check only,
 * since the real bytes go straight to Storage and we never see them here.
 * Acceptable BECAUSE of the role check below, which is what makes the old
 * version of this comment's "this whole surface is already
 * ho_admin/super_admin only" claim actually true: it was inherited from the
 * /data-upload PAGE's gate and never carried across to this route when the
 * direct-to-Storage refactor (2026-08-25) moved the entry point here, so
 * until now any signed-in user of any role could mint an unlimited number
 * of service-role signed upload URLs into the private erp-reports bucket
 * (audit B-04). createUploadUrl uses the SERVICE-ROLE client
 * (lib/storage/supabase.ts:35), which bypasses Storage policies entirely —
 * so this route's own check is the only gate that exists on that write.
 */
export async function POST(request: Request) {
  const supabase = await createDataClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: { code: "unauthorized", message: "Not signed in." } }, { status: 401 });
  }

  const denied = await roleFailure(supabase, user.id, "Only HO Admin / Super Admin can upload ERP reports.");
  if (denied) return denied;

  const body = await request.json().catch(() => null);
  const reportType = body?.reportType;
  const fileName = body?.fileName;
  const fileSize = body?.fileSize;
  const contentType = body?.contentType;

  if (typeof reportType !== "string" || !REPORT_TYPES.includes(reportType as ReportType)) {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_body", message: "reportType must be one of sale, stock, scheme, master." } },
      { status: 400 }
    );
  }
  if (typeof fileName !== "string" || !fileName) {
    return NextResponse.json({ ok: false, error: { code: "invalid_body", message: "fileName is required." } }, { status: 400 });
  }
  if (typeof fileSize !== "number" || fileSize > MAX_BYTES) {
    return NextResponse.json({ ok: false, error: { code: "file_too_large", message: "File must be under 50MB." } }, { status: 400 });
  }
  if (typeof contentType !== "string" || !ALLOWED_TYPES.includes(contentType)) {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_type", message: "Only .xlsx or .xls files are accepted." } },
      { status: 400 }
    );
  }

  const path = `${reportType}/${user.id}/${Date.now()}-${fileName}`;

  try {
    const { signedUrl, token } = await createUploadUrl("erp-reports", path);
    return NextResponse.json({
      ok: true,
      data: {
        path,
        signedUrl,
        token,
        // The anon key doubles as Storage's required `apikey` header on the
        // direct PUT — already public (shipped to every browser via
        // NEXT_PUBLIC_*), not a new exposure. Returned here rather than
        // read from process.env client-side so the browser code doesn't
        // need to know which env var name carries it.
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: { code: "upload_url_failed", message: err instanceof Error ? err.message : "Could not prepare upload." } },
      { status: 500 }
    );
  }
}
