"use client";

import { useState } from "react";

/**
 * One editable cell in the Targets daily tracker's Remarks column (0032) —
 * free text a store's staff (or anyone with /targets access) can type to
 * explain why that day's sale was up or down. Saves on blur, not on every
 * keystroke, same "commit when the user is done" idea as the rest of this
 * page's forms. Backed by ops.daily_target_remarks via
 * /api/targets/remarks — that route's own auth check + the table's RLS
 * (store_id = any(core.fn_user_store_ids())) are the real access boundary;
 * `editable` here just decides whether to render a textarea instead of
 * plain text, it grants nothing by itself.
 */
export function RemarkCell({
  storeId,
  date,
  bucket,
  initialText,
  editable,
}: {
  storeId: string;
  date: string;
  bucket: "fresh" | "discounted";
  initialText: string;
  editable: boolean;
}) {
  const [text, setText] = useState(initialText);
  const [saved, setSaved] = useState(initialText);
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");

  async function save() {
    if (text === saved) return; // nothing changed since last save/load
    setStatus("saving");
    try {
      const res = await fetch("/api/targets/remarks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ store_id: storeId, date, bucket, remark_text: text }),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error?.message ?? "Save failed");
      setSaved(text);
      setStatus("idle");
    } catch {
      setStatus("error");
    }
  }

  if (!editable) {
    return <span className="block max-w-[220px] whitespace-pre-wrap text-[12px] text-ink-2">{text || "—"}</span>;
  }

  return (
    <div className="flex flex-col gap-0.5">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        rows={1}
        placeholder="Why up/down…"
        className="min-w-[160px] max-w-[220px] resize-y border border-line-soft bg-surface px-1.5 py-1 text-[12px] text-ink-2 focus:border-line focus:outline-none"
      />
      {status === "saving" && <span className="text-[10px] text-ink-3">Saving…</span>}
      {status === "error" && <span className="text-[10px] text-crit">Couldn&apos;t save — try again</span>}
    </div>
  );
}
