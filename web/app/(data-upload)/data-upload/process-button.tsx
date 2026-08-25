"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";

type PreviewData = {
  reportType: "sale" | "stock" | "scheme" | "master";
  totalRows: number;
  validRows: number;
  errorRows: number;
  sampleErrors: { rowNumber: number; error: string }[];
  totalClosingStock?: number;
  withScheme?: number;
  /**
   * Master only. Unlike the Sale/Stock reports, whose headers are fixed, the
   * item master is matched by fuzzy column aliases — so the ONE thing worth
   * showing before committing is which of the user's columns the parser
   * decided each field came from. A silently wrong mapping (e.g. "size"
   * landing on size_group when they meant a size label) is invisible in a
   * row count but obvious here.
   */
  headerMapping?: Record<string, string>;
  headersFound?: string[];
  duplicatesCollapsed?: number;
};

type State =
  | { step: "idle" }
  | { step: "loading-preview" }
  | { step: "preview"; data: PreviewData }
  | { step: "committing"; data: PreviewData; committedSoFar: number; totalRows: number | null }
  | { step: "done"; committedRows: number; skippedRows: number }
  | { step: "error"; message: string };

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: { ok: boolean; data?: T; error?: { message: string } };
  try {
    json = await res.json();
  } catch {
    throw new Error(`Server sent back something unreadable (status ${res.status}).`);
  }
  if (!res.ok || !json.ok) throw new Error(json.error?.message ?? `Request failed (status ${res.status}).`);
  return json.data as T;
}

// Master files can be large enough that one commit request exceeds Vercel's
// 60s ceiling — confirmed live 2026-08-25: 93,300 rows took 52.8s for the
// DB upsert alone, before file download/parse/network overhead. Matches
// api/data-upload/process/[id]/commit/route.ts's own MASTER_BATCH_SIZE (the
// server slices rows the same way regardless of what batchSize the client
// sends, so this only needs to roughly agree, not match exactly).
const MASTER_BATCH_SIZE = 8000;

type MasterCommitBatch = {
  committedRows: number;
  insertedRows: number;
  updatedRows: number;
  duplicatesCollapsed: number;
  skippedRows: number;
  totalRows: number;
  nextOffset: number;
  done: boolean;
};

/**
 * Explicit "validate -> preview -> commit" UI per migration 0024 / 0018's
 * stated convention — never a direct parse-and-insert on click. Preview
 * shows row counts and a sample of row-level errors; commit is a second,
 * separate confirmation.
 */
export function ProcessButton({ uploadId }: { uploadId: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ step: "idle" });

  // TopProgressBar.tsx's own completion detection is route-change-based
  // (pathname/searchParams), which never fires here — this whole flow only
  // calls router.refresh() at the very end, which re-fetches server data
  // in place without touching the URL at all. Dispatching start/stop
  // directly is what makes the top strip actually track this fetch instead
  // of falling back to its 20s stuck-open safety timer.
  async function loadPreview() {
    setState({ step: "loading-preview" });
    window.dispatchEvent(new CustomEvent("progressbar:start"));
    try {
      const data = await postJson<PreviewData>(`/api/data-upload/process/${uploadId}/preview`);
      setState({ step: "preview", data });
    } catch (err) {
      // A missing catch here previously left the UI stuck on its loading
      // state forever if the request errored (e.g. a Vercel timeout
      // returning an HTML error page instead of JSON) — the exception went
      // uncaught, so no setState ever ran after that point.
      setState({ step: "error", message: err instanceof Error ? err.message : "Couldn't read that file." });
    } finally {
      window.dispatchEvent(new CustomEvent("progressbar:stop"));
    }
  }

  async function commit() {
    if (state.step !== "preview") return;
    const previewData = state.data;
    setState({ step: "committing", data: previewData, committedSoFar: 0, totalRows: previewData.validRows });
    window.dispatchEvent(new CustomEvent("progressbar:start"));
    try {
      if (previewData.reportType === "master") {
        // Batched — loop of small commit requests, each with its own fresh
        // 60s budget, instead of one request for the whole file. See
        // commit/route.ts's own header for the full story.
        let offset = 0;
        let last: MasterCommitBatch | null = null;
        for (;;) {
          const batch = await postJson<MasterCommitBatch>(`/api/data-upload/process/${uploadId}/commit`, {
            offset,
            batchSize: MASTER_BATCH_SIZE,
          });
          last = batch;
          offset = batch.nextOffset;
          setState({ step: "committing", data: previewData, committedSoFar: Math.min(offset, batch.totalRows), totalRows: batch.totalRows });
          if (batch.done) break;
        }
        setState({ step: "done", committedRows: last!.committedRows, skippedRows: last!.skippedRows });
      } else {
        const data = await postJson<{ committedRows: number; skippedRows: number }>(
          `/api/data-upload/process/${uploadId}/commit`
        );
        setState({ step: "done", committedRows: data.committedRows, skippedRows: data.skippedRows });
      }
      router.refresh();
    } catch (err) {
      setState({ step: "error", message: err instanceof Error ? err.message : "Commit failed." });
    } finally {
      window.dispatchEvent(new CustomEvent("progressbar:stop"));
    }
  }

  if (state.step === "idle") {
    return (
      <button
        onClick={loadPreview}
        className="border border-line px-2 py-1 text-[11px] uppercase tracking-wide text-ink-2 hover:text-ink"
      >
        Process
      </button>
    );
  }

  if (state.step === "loading-preview") {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-ink-3">
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-line-soft border-t-ink-3" />
        Reading file…
      </span>
    );
  }

  if (state.step === "error") {
    return (
      <span className="flex items-center gap-2 text-[11px]">
        <span className="text-crit">{state.message}</span>
        <button onClick={() => setState({ step: "idle" })} className="text-ink-3 underline">
          Dismiss
        </button>
      </span>
    );
  }

  if (state.step === "done") {
    return (
      <span className="text-[11px] text-good">
        Processed — {state.committedRows} rows committed
        {state.skippedRows > 0 ? `, ${state.skippedRows} skipped (see notes)` : ""}.
      </span>
    );
  }

  // preview or committing
  const data = state.data;
  const committing = state.step === "committing";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="max-w-lg border border-line bg-surface p-5 text-sm shadow-lg">
        <h3 className="font-serif text-lg">Confirm processing</h3>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[13px]">
          <dt className="text-ink-3">Report type</dt>
          <dd className="capitalize">{data.reportType}</dd>
          <dt className="text-ink-3">Total rows</dt>
          <dd>{data.totalRows}</dd>
          <dt className="text-ink-3">Valid rows (will commit)</dt>
          <dd>{data.validRows}</dd>
          <dt className="text-ink-3">Rows with errors (skipped)</dt>
          <dd>{data.errorRows}</dd>
          {data.reportType === "stock" && data.totalClosingStock != null && (
            <>
              <dt className="text-ink-3">Total closing stock</dt>
              <dd>{data.totalClosingStock.toLocaleString("en-IN")}</dd>
            </>
          )}
          {data.reportType === "scheme" && data.withScheme != null && (
            <>
              <dt className="text-ink-3">Barcodes with a scheme</dt>
              <dd>{data.withScheme.toLocaleString("en-IN")}</dd>
            </>
          )}
          {data.reportType === "master" && data.duplicatesCollapsed != null && (
            <>
              <dt className="text-ink-3">Duplicate item codes collapsed</dt>
              <dd>{data.duplicatesCollapsed.toLocaleString("en-IN")}</dd>
            </>
          )}
        </dl>

        {/*
          Master only: show the resolved column mapping. Row counts cannot
          reveal a mis-mapped column — the file parses "successfully" either
          way — so this table is the actual check before committing.
        */}
        {data.reportType === "master" && data.headerMapping && (
          <div className="mt-3">
            <p className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
              Column mapping — check this before committing
            </p>
            <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-0.5 border-l-2 border-line-soft bg-canvas-2 px-3 py-2 text-[12px]">
              {Object.entries(data.headerMapping).map(([field, column]) => (
                <Fragment key={field}>
                  <dt className="text-ink-3">{field}</dt>
                  <dd className="font-mono text-[11.5px]">{column}</dd>
                </Fragment>
              ))}
            </dl>
            {data.headersFound && data.headersFound.length > 0 && (
              <p className="mt-1.5 text-[11px] text-ink-3">
                Unmapped columns are ignored. All headers read:{" "}
                <span className="font-mono">{data.headersFound.join(", ")}</span>
              </p>
            )}
          </div>
        )}

        {data.reportType === "stock" && (
          <p className="mt-3 border-l-2 border-line-soft bg-canvas-2 px-3 py-2 text-[12px] text-ink-3">
            This REPLACES the current stock snapshot entirely — the previous snapshot will no longer be
            queryable once this commits.
          </p>
        )}
        {data.reportType === "scheme" && (
          <p className="mt-3 border-l-2 border-line-soft bg-canvas-2 px-3 py-2 text-[12px] text-ink-3">
            This REPLACES the current scheme lookup entirely.
          </p>
        )}

        {data.sampleErrors.length > 0 && (
          <div className="mt-3">
            <p className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
              Sample errors (first {data.sampleErrors.length})
            </p>
            <ul className="mt-1 max-h-32 overflow-y-auto text-[12px] text-ink-2">
              {data.sampleErrors.map((e) => (
                <li key={e.rowNumber}>
                  Row {e.rowNumber}: {e.error}
                </li>
              ))}
            </ul>
          </div>
        )}

        {committing && state.totalRows !== null && state.totalRows > 0 && (
          <div className="mt-3">
            <div className="flex items-center justify-between text-[11px] text-ink-3">
              <span>
                Committing… {state.committedSoFar.toLocaleString("en-IN")} / {state.totalRows.toLocaleString("en-IN")} rows
              </span>
              <span>{Math.round((state.committedSoFar / state.totalRows) * 100)}%</span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full bg-accent transition-[width]"
                style={{ width: `${Math.min(100, Math.round((state.committedSoFar / state.totalRows) * 100))}%` }}
              />
            </div>
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={() => setState({ step: "idle" })}
            disabled={committing}
            className="border border-line px-3 py-1.5 text-[12px] text-ink-2 hover:text-ink disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            onClick={commit}
            disabled={committing}
            className="bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-fg disabled:opacity-60"
          >
            {committing ? (
              <span className="flex items-center gap-1.5">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent-fg/30 border-t-accent-fg" />
                Committing…
              </span>
            ) : (
              "Commit"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
