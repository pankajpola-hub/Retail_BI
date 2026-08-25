"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

const REPORT_LABELS: Record<string, string> = {
  sale: "Sale report",
  stock: "Stock report",
  scheme: "Scheme report",
  master: "Master (item attributes)",
};

type UploadStatus =
  | { state: "idle" }
  | { state: "uploading"; percent: number }
  | { state: "error"; message: string }
  | { state: "done" };

/**
 * XMLHttpRequest, not fetch() — fetch has no upload-progress event at all
 * (only download progress, via the response body stream), so a fetch-based
 * form has nothing to report while the file itself is going up. That
 * silence is exactly what read as "stuck" for a multi-MB master file: the
 * button just said "Uploading…" with no percentage, for however long the
 * browser->Vercel hop actually took. xhr.upload.onprogress gives a real
 * byte-level percentage to show instead.
 */
function uploadWithProgress(url: string, formData: FormData, onPercent: (pct: number) => void): Promise<{ ok: boolean; body: unknown }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onPercent(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      try {
        resolve({ ok: xhr.status >= 200 && xhr.status < 300, body: JSON.parse(xhr.responseText) });
      } catch {
        resolve({ ok: false, body: { error: { message: "Server sent back something unreadable." } } });
      }
    };
    xhr.onerror = () => reject(new Error("Network error during upload."));
    xhr.ontimeout = () => reject(new Error("Upload timed out."));
    xhr.send(formData);
  });
}

export function UploadReportForm({ reportType }: { reportType: "sale" | "stock" | "scheme" | "master" }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<UploadStatus>({ state: "idle" });

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;

    setStatus({ state: "uploading", percent: 0 });
    const formData = new FormData();
    formData.append("file", file);
    formData.append("report_type", reportType);

    let result: { ok: boolean; body: unknown };
    try {
      result = await uploadWithProgress("/api/data-upload/upload", formData, (percent) =>
        setStatus({ state: "uploading", percent })
      );
    } catch (err) {
      setStatus({ state: "error", message: err instanceof Error ? err.message : "Upload failed." });
      return;
    }

    const body = result.body as { ok: boolean; error?: { message: string } };
    if (!result.ok || !body.ok) {
      setStatus({ state: "error", message: body.error?.message ?? "Upload failed." });
      return;
    }
    setStatus({ state: "done" });
    if (fileRef.current) fileRef.current.value = "";
    router.refresh();
  }

  const uploading = status.state === "uploading";

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 border border-line-soft p-4">
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
          {REPORT_LABELS[reportType]} (.xlsx or .xls, up to 20MB)
        </span>
        <input ref={fileRef} type="file" accept=".xlsx,.xls" required disabled={uploading} className="text-sm" />
      </label>
      <Button type="submit" disabled={uploading} className="self-start">
        {uploading ? `Uploading… ${status.percent}%` : "Upload"}
      </Button>
      {uploading && (
        <div className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-surface-2">
          <div className="h-full bg-accent transition-[width]" style={{ width: `${status.percent}%` }} />
        </div>
      )}
      {status.state === "error" && (
        <p className="border-l-2 border-crit bg-crit-soft px-3 py-2 text-sm text-ink-2">{status.message}</p>
      )}
      {status.state === "done" && (
        <p className="border-l-2 border-good bg-good-soft px-3 py-2 text-sm text-ink-2">Uploaded.</p>
      )}
    </form>
  );
}
