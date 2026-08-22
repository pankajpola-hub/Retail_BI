"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/data/client";
import type { DataClient } from "@/lib/data/client";
import { getDownloadUrl } from "@/lib/storage/supabase";
import { SCHEDULED_EXPORTS_BUCKET } from "@/lib/exports/scheduledExports";

/**
 * Phase 5 (Track B) scheduled-exports CRUD, deliberately thin like
 * lib/workspace/actions.ts: ops.scheduled_exports is owner-only RLS
 * (migration 0071's scheduled_exports_owner_all), so these actions call the
 * caller's own RLS-scoped client (lib/data/client.ts), never the admin
 * client — nothing here needs to bypass RLS. Kept in a new file rather than
 * added to lib/workspace/actions.ts so this feature doesn't touch that
 * shared file (see the Track A/B split's file-ownership table).
 */

export type ExportType = "replenishment" | "footfall_completeness" | "targets_audit";
export type Frequency = "daily" | "weekly";
const EXPORT_TYPES: ExportType[] = ["replenishment", "footfall_completeness", "targets_audit"];
const FREQUENCIES: Frequency[] = ["daily", "weekly"];

export type ScheduledExportSummary = {
  id: string;
  exportType: ExportType;
  frequency: Frequency;
  lastRunAt: string | null;
  downloadUrl: string | null;
};

type ScheduledExportRow = {
  id: string;
  export_type: ExportType;
  frequency: Frequency;
  last_run_at: string | null;
  last_file_path: string | null;
};

async function requireCallerId(supabase: DataClient): Promise<string> {
  const {
    data: { user: caller },
  } = await supabase.auth.getUser();
  if (!caller) throw new Error("Not authenticated.");
  return caller.id;
}

/**
 * The caller's own schedules — RLS (scheduled_exports_owner_all) already
 * narrows this to owner_id = caller, so no app-side owner filter is added,
 * same posture as listMyWorkspaces. A signed download URL is generated per
 * row that already has a last_file_path — best-effort: a signing failure
 * (e.g. the bucket isn't provisioned yet) degrades that one row's link to
 * null rather than failing the whole list.
 */
export async function listMyScheduledExports(): Promise<ScheduledExportSummary[]> {
  const supabase = await createClient();
  await requireCallerId(supabase);

  const { data, error } = await supabase
    .schema("ops")
    .from<ScheduledExportRow>("scheduled_exports")
    .select("id, export_type, frequency, last_run_at, last_file_path")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);

  const rows = data ?? [];
  return Promise.all(
    rows.map(async (row) => {
      let downloadUrl: string | null = null;
      if (row.last_file_path) {
        try {
          downloadUrl = await getDownloadUrl(SCHEDULED_EXPORTS_BUCKET, row.last_file_path);
        } catch {
          downloadUrl = null;
        }
      }
      return {
        id: row.id,
        exportType: row.export_type,
        frequency: row.frequency,
        lastRunAt: row.last_run_at,
        downloadUrl,
      };
    })
  );
}

export async function createScheduledExport(exportType: ExportType, frequency: Frequency): Promise<void> {
  const supabase = await createClient();
  const ownerId = await requireCallerId(supabase);

  if (!EXPORT_TYPES.includes(exportType)) throw new Error("Unknown export type.");
  if (!FREQUENCIES.includes(frequency)) throw new Error("Unknown frequency.");

  const { error } = await supabase
    .schema("ops")
    .from("scheduled_exports")
    .insert({ owner_id: ownerId, export_type: exportType, frequency });
  if (error) throw new Error(error.message);
  revalidatePath("/workspace");
}

/** RLS (scheduled_exports_owner_all) already restricts this to the owner — no app-side ownership re-check needed beyond requireCallerId. */
export async function deleteScheduledExport(id: string): Promise<void> {
  const supabase = await createClient();
  await requireCallerId(supabase);

  const { error } = await supabase.schema("ops").from("scheduled_exports").delete().eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/workspace");
}
