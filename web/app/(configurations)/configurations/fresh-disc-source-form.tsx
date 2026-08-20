"use client";

import { useState } from "react";
import { setFreshDiscClassificationSource } from "./actions";
import { Button } from "@/components/ui/button";

type Source = "discount_ratio" | "scheme_lookup";
type SaveStatus = { state: "idle" } | { state: "saving" } | { state: "error"; message: string } | { state: "done" };

export function FreshDiscSourceForm({
  current,
  labels,
}: {
  current: Source;
  labels: { ratio: string; ratioHint: string; scheme: string; schemeHint: string; save: string; saved: string };
}) {
  const [source, setSource] = useState<Source>(current);
  const [status, setStatus] = useState<SaveStatus>({ state: "idle" });

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus({ state: "saving" });
    try {
      await setFreshDiscClassificationSource(source);
      setStatus({ state: "done" });
    } catch (err) {
      setStatus({ state: "error", message: err instanceof Error ? err.message : "Save failed." });
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 border border-line-soft p-4">
      <label className="flex cursor-pointer items-start gap-2.5">
        <input
          type="radio"
          name="fresh-disc-source"
          checked={source === "discount_ratio"}
          onChange={() => {
            setSource("discount_ratio");
            setStatus({ state: "idle" });
          }}
          className="mt-1"
        />
        <span>
          <span className="block text-sm font-semibold">{labels.ratio}</span>
          <span className="block text-[12px] text-ink-3">{labels.ratioHint}</span>
        </span>
      </label>

      <label className="flex cursor-pointer items-start gap-2.5">
        <input
          type="radio"
          name="fresh-disc-source"
          checked={source === "scheme_lookup"}
          onChange={() => {
            setSource("scheme_lookup");
            setStatus({ state: "idle" });
          }}
          className="mt-1"
        />
        <span>
          <span className="block text-sm font-semibold">{labels.scheme}</span>
          <span className="block text-[12px] text-ink-3">{labels.schemeHint}</span>
        </span>
      </label>

      <div className="mt-1">
        <Button type="submit" disabled={status.state === "saving" || source === current}>
          {status.state === "saving" ? "…" : labels.save}
        </Button>
      </div>

      {status.state === "error" && (
        <p className="border-l-2 border-crit bg-crit-soft px-3 py-2 text-sm text-ink-2">{status.message}</p>
      )}
      {status.state === "done" && (
        <p className="border-l-2 border-good bg-good-soft px-3 py-2 text-sm text-ink-2">{labels.saved}</p>
      )}
    </form>
  );
}
