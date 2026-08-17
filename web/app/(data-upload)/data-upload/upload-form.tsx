"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

const REPORT_LABELS: Record<string, string> = {
  sale: "Sale report",
  stock: "Stock report",
  scheme: "Scheme report",
  master: "Master (item attributes)",
};

export function UploadReportForm({ reportType }: { reportType: "sale" | "stock" | "scheme" | "master" }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<
    { state: "idle" } | { state: "uploading" } | { state: "error"; message: string } | { state: "done" }
  >({ state: "idle" });

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;

    setStatus({ state: "uploading" });
    const formData = new FormData();
    formData.append("file", file);
    formData.append("report_type", reportType);

    const res = await fetch("/api/data-upload/upload", { method: "POST", body: formData });
    const body = await res.json();

    if (!body.ok) {
      setStatus({ state: "error", message: body.error.message });
      return;
    }
    setStatus({ state: "done" });
    if (fileRef.current) fileRef.current.value = "";
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 border border-line-soft p-4">
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
          {REPORT_LABELS[reportType]} (.xlsx or .xls, up to 20MB)
        </span>
        <input ref={fileRef} type="file" accept=".xlsx,.xls" required className="text-sm" />
      </label>
      <button
        type="submit"
        disabled={status.state === "uploading"}
        className="self-start bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
      >
        {status.state === "uploading" ? "Uploading…" : "Upload"}
      </button>
      {status.state === "error" && (
        <p className="border-l-2 border-crit bg-crit-soft px-3 py-2 text-sm text-ink-2">{status.message}</p>
      )}
      {status.state === "done" && (
        <p className="border-l-2 border-good bg-good-soft px-3 py-2 text-sm text-ink-2">Uploaded.</p>
      )}
    </form>
  );
}
