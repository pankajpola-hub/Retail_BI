"use client";

import { useState, useTransition } from "react";
import { createScheduledExport, deleteScheduledExport, type ScheduledExportSummary, type ExportType, type Frequency } from "@/lib/exports/actions";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const EXPORT_TYPE_LABELS: Record<ExportType, string> = {
  replenishment: "Replenishment (full network)",
  footfall_completeness: "Footfall completeness (trailing 30 days, your stores)",
  targets_audit: "Targets audit (previous month, your stores)",
};

/**
 * Phase 5 (Track B) — scheduled exports panel inside the existing Workspace
 * page. Not a new nav item/PageKey (per the plan's Track B scope): this is
 * a section of the same `workspace` page, gated by the same
 * requirePageAccess("workspace") the rest of the page already sits behind.
 *
 * Each schedule regenerates one of the three existing XLSX reports on a
 * daily/weekly cadence (app/api/cron/scheduled-exports) and this panel is
 * purely the in-app download surface for the result — no email, matching
 * the plan's explicit v1 scope (no SMTP exists in this app).
 */
export function ScheduledExportsPanel({ initialSchedules }: { initialSchedules: ScheduledExportSummary[] }) {
  const [schedules, setSchedules] = useState(initialSchedules);
  const [exportType, setExportType] = useState<ExportType>("replenishment");
  const [frequency, setFrequency] = useState<Frequency>("weekly");
  const [isPending, startTransition] = useTransition();

  function handleCreate() {
    startTransition(async () => {
      await createScheduledExport(exportType, frequency);
      // Re-derive the list from the server so the new row (and any signed
      // URL work the server action does) is authoritative rather than
      // optimistically guessed here.
      window.location.reload();
    });
  }

  function handleDelete(id: string) {
    startTransition(async () => {
      await deleteScheduledExport(id);
      setSchedules((prev) => prev.filter((s) => s.id !== id));
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Scheduled exports</CardTitle>
        <CardDescription>
          Automatically regenerate a report on a daily/weekly cadence and download the latest run — no email, in-app
          link only.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {schedules.length === 0 ? (
          <p className="text-[12.5px] text-ink-3">No scheduled exports yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {schedules.map((s) => (
              <div
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line-soft p-2.5"
              >
                <div>
                  <p className="text-[12.5px] font-semibold text-ink">{EXPORT_TYPE_LABELS[s.exportType]}</p>
                  <p className="text-[11px] text-ink-3">
                    {s.frequency === "daily" ? "Daily" : "Weekly"} ·{" "}
                    {s.lastRunAt ? `Last run ${new Date(s.lastRunAt).toLocaleString()}` : "Not run yet"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {s.downloadUrl ? (
                    <Button asChild size="sm" variant="secondary">
                      <a href={s.downloadUrl}>Download latest</a>
                    </Button>
                  ) : (
                    <span className="text-[11px] text-ink-3">No file yet</span>
                  )}
                  <Button size="sm" variant="ghost" disabled={isPending} onClick={() => handleDelete(s.id)}>
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-end gap-2 border-t border-line-soft pt-3">
          <label className="flex flex-col gap-1 text-[11px] text-ink-3">
            Report
            <select
              value={exportType}
              onChange={(e) => setExportType(e.target.value as ExportType)}
              className="min-h-[32px] rounded-md border border-line bg-surface px-2 py-1 text-[12.5px] text-ink-2"
            >
              <option value="replenishment">Replenishment</option>
              <option value="footfall_completeness">Footfall completeness</option>
              <option value="targets_audit">Targets audit</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-ink-3">
            Frequency
            <select
              value={frequency}
              onChange={(e) => setFrequency(e.target.value as Frequency)}
              className="min-h-[32px] rounded-md border border-line bg-surface px-2 py-1 text-[12.5px] text-ink-2"
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </label>
          <Button size="sm" disabled={isPending} onClick={handleCreate}>
            Add schedule
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
