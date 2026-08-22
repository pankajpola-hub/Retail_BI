import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Object storage — real Supabase Storage (2026-08-20 migration; replaces
 * `lib/storage/minio.ts`, retired). Same 4-function interface as the file it
 * replaces, so every caller (data-upload/targets-upload routes,
 * erpReports/retention.ts) needed zero changes beyond the import path.
 *
 * Uses the service-role admin client (bypasses Storage's own RLS-like
 * bucket policies) rather than the caller's own session — uploads/reads here
 * are always server-initiated (a route handler already did its own
 * requirePageAccess/role check before calling these), not directly from the
 * browser, so there's no separate end-user identity to scope a Storage
 * policy to; the route's own auth check is the real gate, same posture as
 * every other privileged write in this app (see lib/data/admin.ts's own
 * header on restricted callers).
 */
export async function saveObjectFile(bucket: string, relativePath: string, file: File): Promise<string> {
  // relativePath is built server-side from a uuid and Date.now(), never
  // from raw user input, but strip separators out of the filename segment
  // anyway so a crafted filename can't be interpreted as an object path.
  const safeRelative = relativePath
    .split("/")
    .map((segment) => segment.replace(/[/\\]/g, "_"))
    .join("/");

  const supabase = createAdminClient();
  const { error } = await supabase.storage
    .from(bucket)
    .upload(safeRelative, file, { contentType: file.type || "application/octet-stream", upsert: false });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  return safeRelative;
}

/**
 * Reads an object's full bytes into memory — used server-side by the ERP
 * report processing routes to parse an already-uploaded file with `xlsx`
 * without round-tripping through a signed URL. Fine for the report sizes
 * this app handles (a few MB); don't reach for this on anything large
 * enough to need streaming.
 */
export async function getObjectBuffer(bucket: string, objectPath: string): Promise<Buffer> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.storage.from(bucket).download(objectPath);
  if (error) throw new Error(`Storage download failed: ${error.message}`);
  return Buffer.from(await data.arrayBuffer());
}

/** Best-effort delete — swallows errors so a missing/already-gone object never blocks the caller's own cleanup. */
export async function removeObjectFile(bucket: string, objectPath: string): Promise<void> {
  try {
    const supabase = createAdminClient();
    await supabase.storage.from(bucket).remove([objectPath]);
  } catch {
    // Already gone, or unreachable — the DB row is the source of truth for
    // "what files exist" from the app's perspective either way.
  }
}

/**
 * Signed URL good for a short window — the browser fetches it directly from
 * Supabase Storage, not proxied through a Next.js function, so this never
 * streams a potentially-large report through Vercel.
 */
export async function getDownloadUrl(bucket: string, objectPath: string): Promise<string> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(objectPath, 5 * 60);
  if (error) throw new Error(`Storage signed-URL failed: ${error.message}`);
  return data.signedUrl;
}
