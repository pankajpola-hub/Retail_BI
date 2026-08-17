import "server-only";
import type { DataClient } from "@/lib/data/client";
import { removeObjectFile } from "@/lib/storage/minio";

/**
 * "Always keep the latest file only" — deletes every ops.erp_report_uploads
 * row (and its MinIO object) of the given report_type EXCEPT keepId.
 *
 * WHEN to call this matters and differs by report type:
 *  - "sale": safe to call right after upload. raw_logic.sales_transactions
 *    has no upload_id column at all (sale data accumulates, it's never
 *    "replaced"), so an old upload row is never referenced by anything and
 *    can be deleted immediately.
 *  - "stock" / "scheme": raw_logic.stock_snapshot / scheme_lookup DO have an
 *    upload_id foreign key, and there is only ever ONE live snapshot — the
 *    OLD upload row is still that live snapshot's owner until a NEW upload
 *    is actually PROCESSED (ops.fn_process_stock_upload/_scheme_upload
 *    delete-and-reinsert the snapshot under the NEW upload_id). Calling this
 *    right after upload (before processing) tries to delete a row the
 *    snapshot still points to and fails on the FK constraint — call this
 *    from the commit route, after a successful process, instead.
 *
 * Best-effort: errors are logged (visible in `vercel logs`), never thrown —
 * a cleanup failure shouldn't fail the upload/process the user is actually
 * waiting on, but silently swallowing it entirely (an earlier version did)
 * makes real bugs invisible, which is exactly what happened with the FK
 * constraint above.
 */
export async function cleanupOlderUploads(
  supabase: DataClient,
  reportType: "sale" | "stock" | "scheme" | "master",
  keepId: string
): Promise<void> {
  try {
    const { data: older, error: selectErr } = await supabase
      .schema("ops")
      .from<{ id: string; storage_path: string }>("erp_report_uploads")
      .select("id, storage_path")
      .eq("report_type", reportType)
      .neq("id", keepId);
    if (selectErr) {
      console.error(`[erpReports/retention] select older ${reportType} rows failed: ${JSON.stringify(selectErr)}`);
      return;
    }
    if (!older || older.length === 0) return;

    for (const old of older) {
      await removeObjectFile("erp-reports", old.storage_path);
    }

    const { error: deleteErr } = await supabase
      .schema("ops")
      .from("erp_report_uploads")
      .delete()
      .eq("report_type", reportType)
      .neq("id", keepId);
    if (deleteErr) {
      console.error(
        `[erpReports/retention] delete ${older.length} older ${reportType} row(s) failed: ${JSON.stringify(deleteErr)}`
      );
    }
  } catch (err) {
    console.error(`[erpReports/retention] threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}
