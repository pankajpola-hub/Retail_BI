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
  | { state: "finishing" }
  | { state: "error"; message: string }
  | { state: "done" };

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok || !json.ok) throw new Error(json.error?.message ?? "Request failed.");
  return json.data as T;
}

/**
 * Direct-to-Storage upload, replacing a fetch()-through-our-own-function
 * upload (2026-08-25). Two real problems that one had:
 *
 *  1. No progress at all — fetch() has no upload-progress event, only
 *     "Uploading…" with nothing changing until it resolved or errored.
 *  2. A hard wall for any file over ~4.5MB — Vercel Serverless Functions
 *     have a request-body ceiling that low, a PLATFORM limit no code-level
 *     change (streaming, maxDuration) can raise. A master/sale/stock ERP
 *     report routinely exceeds it; confirmed live as "Server sent back
 *     something unreadable" (an HTML platform error page, not JSON) on a
 *     master file.
 *
 * Fix: the file's bytes go straight from this browser to Supabase Storage
 * via a signed upload URL (see api/data-upload/upload-url/route.ts) — no
 * Next.js function ever sees them, so there's no body-size ceiling to hit.
 * XMLHttpRequest for that PUT specifically because it's the only web API
 * with a real upload-progress event (fetch still doesn't have one).
 */
function putFileToSignedUrl(signedUrl: string, apikey: string, file: File, onPercent: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", signedUrl);
    xhr.setRequestHeader("apikey", apikey);
    xhr.setRequestHeader("Authorization", `Bearer ${apikey}`);
    xhr.setRequestHeader("x-upsert", "false");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onPercent(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Storage upload failed (${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error("Network error during upload."));
    xhr.ontimeout = () => reject(new Error("Upload timed out."));

    // Exact shape Supabase's own uploadToSignedUrl() sends for a File body
    // (a File is a Blob): a "cacheControl" field plus the file itself
    // under an empty-string field name — matched from the installed
    // @supabase/storage-js source rather than guessed, since getting this
    // wrong fails silently against a real endpoint.
    const form = new FormData();
    form.append("cacheControl", "3600");
    form.append("", file);
    xhr.send(form);
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

    try {
      setStatus({ state: "uploading", percent: 0 });
      const { path, signedUrl, apikey } = await postJson<{ path: string; signedUrl: string; token: string; apikey: string }>(
        "/api/data-upload/upload-url",
        { reportType, fileName: file.name, fileSize: file.size, contentType: file.type }
      );

      await putFileToSignedUrl(signedUrl, apikey, file, (percent) => setStatus({ state: "uploading", percent }));

      setStatus({ state: "finishing" });
      await postJson("/api/data-upload/register", { reportType, fileName: file.name, storagePath: path });
    } catch (err) {
      setStatus({ state: "error", message: err instanceof Error ? err.message : "Upload failed." });
      return;
    }

    setStatus({ state: "done" });
    if (fileRef.current) fileRef.current.value = "";
    router.refresh();
  }

  const busy = status.state === "uploading" || status.state === "finishing";

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 border border-line-soft p-4">
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
          {REPORT_LABELS[reportType]} (.xlsx or .xls, up to 50MB)
        </span>
        <input ref={fileRef} type="file" accept=".xlsx,.xls" required disabled={busy} className="text-sm" />
      </label>
      <Button type="submit" disabled={busy} className="self-start">
        {status.state === "uploading" ? `Uploading… ${status.percent}%` : status.state === "finishing" ? "Finishing…" : "Upload"}
      </Button>
      {status.state === "uploading" && (
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
