"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function UploadTargetsForm() {
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

    const res = await fetch("/api/targets/upload", { method: "POST", body: formData });
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
    <form onSubmit={onSubmit} className="flex flex-col gap-3 border border-line-soft p-4 sm:max-w-md">
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
          Target file (.xlsx or .xls, up to 10MB)
        </span>
        <input ref={fileRef} type="file" accept=".xlsx,.xls" required className="text-sm" />
      </label>
      <Button type="submit" disabled={status.state === "uploading"} className="self-start">
        {status.state === "uploading" ? "Uploading…" : "Upload"}
      </Button>
      {status.state === "error" && (
        <p className="border-l-2 border-crit bg-crit-soft px-3 py-2 text-sm text-ink-2">{status.message}</p>
      )}
      {status.state === "done" && (
        <p className="border-l-2 border-good bg-good-soft px-3 py-2 text-sm text-ink-2">
          Uploaded. Parsing isn&apos;t wired up yet — this just stores the file for now.
        </p>
      )}
    </form>
  );
}
