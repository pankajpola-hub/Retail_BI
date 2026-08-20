"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

type PreviewRow = {
  rowNumber: number;
  storeInput: string;
  storeId: string | null;
  storeName: string | null;
  month: string | null;
  freshTarget: number | null;
  discountedTarget: number | null;
  error: string | null;
  existing: { fresh_target_qty: number; discounted_target_qty: number; updated_at: string } | null;
};

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "preview"; rows: PreviewRow[] }
  | { kind: "committing"; rows: PreviewRow[] }
  | { kind: "error"; message: string }
  | { kind: "done"; count: number };

function monthLabel(month: string) {
  return new Date(`${month}-01T00:00:00`).toLocaleDateString("en-IN", { month: "short", year: "numeric" });
}

/**
 * validate → preview → commit, per the pattern the 0018 migration already
 * calls for. /bulk-preview parses the file and reports what would happen
 * (including which rows would overwrite an existing target) without writing
 * anything; only a second, explicit confirm click here calls /bulk-commit.
 */
export function BulkUploadForm() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<State>({ kind: "idle" });

  async function onFileChosen(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;

    setState({ kind: "loading" });
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/targets/monthly/bulk-preview", { method: "POST", body: formData });
    const body = await res.json();

    if (!body.ok) {
      setState({ kind: "error", message: body.error.message });
      return;
    }
    setState({ kind: "preview", rows: body.data.rows });
  }

  async function commit() {
    if (state.kind !== "preview") return;
    const validRows = state.rows.filter((r) => !r.error);
    setState({ kind: "committing", rows: state.rows });

    const res = await fetch("/api/targets/monthly/bulk-commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rows: validRows.map((r) => ({
          storeId: r.storeId,
          month: r.month,
          freshTarget: r.freshTarget,
          discountedTarget: r.discountedTarget,
        })),
      }),
    });
    const body = await res.json();

    if (!body.ok) {
      setState({ kind: "error", message: body.error.message });
      return;
    }
    setState({ kind: "done", count: body.data.count });
    if (fileRef.current) fileRef.current.value = "";
    router.refresh();
  }

  const validCount = state.kind === "preview" || state.kind === "committing" ? state.rows.filter((r) => !r.error).length : 0;
  const overwriteCount =
    state.kind === "preview" || state.kind === "committing" ? state.rows.filter((r) => !r.error && r.existing).length : 0;

  return (
    <div className="border border-line-soft p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[12.5px] text-ink-3">
          Columns: Store, Date (DD-MM-YYYY, any date in the target month), Fresh target (Units), Discounted
          target (Units). One row per store per month.
        </p>
        <a
          href="/api/targets/monthly/template"
          className="whitespace-nowrap border border-line px-3 py-1.5 text-[12.5px] text-ink-2 hover:text-ink"
        >
          Download sample .xlsx
        </a>
      </div>

      <form onSubmit={onFileChosen} className="mt-3 flex flex-wrap items-center gap-3">
        <input ref={fileRef} type="file" accept=".xlsx,.xls" required className="text-sm" />
        <Button type="submit" disabled={state.kind === "loading"}>
          {state.kind === "loading" ? "Reading…" : "Preview"}
        </Button>
      </form>

      {state.kind === "error" && (
        <p className="mt-3 border-l-2 border-crit bg-crit-soft px-3 py-2 text-sm text-ink-2">{state.message}</p>
      )}
      {state.kind === "done" && (
        <p className="mt-3 border-l-2 border-good bg-good-soft px-3 py-2 text-sm text-ink-2">
          Saved {state.count} target{state.count === 1 ? "" : "s"}.
        </p>
      )}

      {(state.kind === "preview" || state.kind === "committing") && (
        <div className="mt-4">
          <div className="overflow-x-auto border border-line-soft">
            <table className="w-full min-w-[640px] text-[12.5px]">
              <thead>
                <tr className="border-b border-line-soft bg-surface-2 text-left text-[10px] uppercase tracking-wide text-ink-3">
                  <th className="px-2 py-2">Row</th>
                  <th className="px-2 py-2">Store</th>
                  <th className="px-2 py-2">Month</th>
                  <th className="px-2 py-2 text-right">Fresh</th>
                  <th className="px-2 py-2 text-right">Discounted</th>
                  <th className="px-2 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {state.rows.map((r) => (
                  <tr key={r.rowNumber} className="border-b border-line-soft last:border-0">
                    <td className="px-2 py-1.5 font-mono text-ink-3">{r.rowNumber}</td>
                    <td className="px-2 py-1.5">{r.storeName ?? (r.storeInput || "—")}</td>
                    <td className="px-2 py-1.5">{r.month ? monthLabel(r.month) : "—"}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{r.freshTarget ?? "—"}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{r.discountedTarget ?? "—"}</td>
                    <td className="px-2 py-1.5 text-[12px]">
                      {r.error ? (
                        <span className="text-crit">{r.error}</span>
                      ) : r.existing ? (
                        <span className="text-warn">
                          Will overwrite {r.existing.fresh_target_qty}/{r.existing.discounted_target_qty}
                        </span>
                      ) : (
                        <span className="text-good">New</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <p className="text-[13px] text-ink-2">
              {validCount} of {state.rows.length} row{state.rows.length === 1 ? "" : "s"} ready to save
              {overwriteCount > 0 && ` — ${overwriteCount} will overwrite an existing target`}.
            </p>
            <Button onClick={commit} disabled={validCount === 0 || state.kind === "committing"}>
              {state.kind === "committing" ? "Saving…" : `Confirm and save ${validCount} target${validCount === 1 ? "" : "s"}`}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
