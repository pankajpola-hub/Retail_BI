import { NextResponse } from "next/server";
import { createClient as createDataClient } from "@/lib/data/client";
import { getObjectBuffer } from "@/lib/storage/supabase";

type UploadRow = { storage_path: string; file_name: string };

/**
 * Proxies the file through this function rather than redirecting to a MinIO
 * signed URL — MinIO on the self-hosted box is only reachable over plain
 * HTTP (no TLS cert set up for it), and a redirect from this HTTPS page to
 * an http:// URL is exactly the "insecure download" pattern modern
 * Chrome/Edge silently block, which is what made downloads look broken with
 * no visible error. Proxying keeps the whole exchange on HTTPS from the
 * browser's point of view — only this server-side function talks to MinIO
 * directly, same as the ERP report processing routes already do via
 * getObjectBuffer. Fine for these report sizes (a few MB, well under
 * Vercel's function response limits); don't reach for this pattern for
 * anything large enough to need streaming.
 *
 * RLS on ops.erp_report_uploads (ho_admin/super_admin only) is what actually
 * gates this; the select below returns nothing for anyone else, which reads
 * here as "not found" rather than "forbidden" — deliberately, so this
 * endpoint doesn't confirm to an unauthorized caller that a given id even
 * exists.
 */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const supabase = await createDataClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: { code: "unauthorized", message: "Not signed in." } }, { status: 401 });
  }

  const { data: upload } = await supabase
    .schema("ops")
    .from<UploadRow>("erp_report_uploads")
    .select("storage_path, file_name")
    .eq("id", params.id)
    .maybeSingle();

  if (!upload) {
    return NextResponse.json({ ok: false, error: { code: "not_found", message: "File not found." } }, { status: 404 });
  }

  let buffer: Buffer;
  try {
    buffer = await getObjectBuffer("erp-reports", upload.storage_path);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: { code: "storage_error", message: err instanceof Error ? err.message : "Could not read the file." } },
      { status: 502 }
    );
  }

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/octet-stream",
      // file_name originates from client JSON (data-upload/register/route.ts
      // takes body?.fileName and only checks it is a non-empty string), so
      // it reaches this header as attacker-influenced text. Stripping just
      // the double quote left CR, LF and ";" through — a header-injection
      // shape (audit B-12). Allow-list instead of deny-list: anything
      // outside word chars, dot, dash and space becomes "_".
      "Content-Disposition": `attachment; filename="${upload.file_name.replace(/[^\w.\- ]/g, "_")}"`,
      "Content-Length": String(buffer.length),
    },
  });
}
