"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setStoreDisplayCapacity } from "./actions";
import {
  buildCapacityTotals,
  DEFAULT_BUFFER_PCT,
  DEFAULT_FRESH_PCT,
  type CapacityBlock,
} from "@/lib/stockDetails/aggregate";

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-IN");
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  // timeZone must be explicit — "en-IN" only controls number/date FORMAT
  // (e.g. day-month-year ordering), not which clock the time is read from.
  // Without it, Vercel's UTC server clock renders unconverted (labeled as if
  // it were IST), showing every timestamp ~5.5 hours behind the real time.
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
}

type Draft = { base: string; bufferPct: string; freshPct: string };

/**
 * One store's 4 base-capacity blocks (Girls/Boys x Baby/Kids) — the EDIT
 * form only. How the resulting planned numbers compare against current
 * actual stock lives in a separate, dedicated table on the page
 * (StockVsCapacityTable) — this card used to also show that comparison
 * inline per block, which buried the one number a store manager actually
 * needs ("am I short or long") inside a wall of edit inputs and admin-only
 * overrides. Keeping the two concerns apart: this card is "what capacity is
 * planned and who set it," the table is "how does that compare to what's on
 * the floor right now."
 *
 * Admin edit (ho_admin/super_admin, canEdit=true) shows, per block, a Base
 * capacity input plus Buffer% and Fresh% override inputs (blank = use the
 * app-wide default — see DEFAULT_BUFFER_PCT/DEFAULT_FRESH_PCT), and a single
 * Save button that upserts all 4 at once via setStoreDisplayCapacity. Every
 * other role gets the exact same numbers rendered read-only — canEdit only
 * ever removes the inputs, never the data.
 */
export function CapacityEditorCard({
  storeId,
  storeName,
  blocks,
  namesByUserId,
  canEdit,
}: {
  storeId: string;
  storeName: string;
  blocks: CapacityBlock[];
  namesByUserId: Record<string, string>;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [drafts, setDrafts] = useState<Record<string, Draft>>(
    Object.fromEntries(
      blocks.map((b) => [
        `${b.gender}-${b.ageSegment}`,
        {
          base: String(b.baseCapacity),
          bufferPct: b.bufferPctOverride === null ? "" : String(b.bufferPctOverride),
          freshPct: b.freshPctOverride === null ? "" : String(b.freshPctOverride),
        },
      ])
    )
  );
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<{ kind: "idle" | "error" | "done"; message?: string }>({
    kind: "idle",
  });

  const totals = buildCapacityTotals(blocks);

  const emptyDraft: Draft = { base: "", bufferPct: "", freshPct: "" };

  function updateDraft(key: string, field: keyof Draft, value: string) {
    setDrafts((prev) => ({ ...prev, [key]: { ...(prev[key] ?? emptyDraft), [field]: value } }));
  }

  function onSave() {
    const values = blocks.map((b) => {
      const key = `${b.gender}-${b.ageSegment}`;
      const d = drafts[key] ?? emptyDraft;
      const base = Number(d.base);
      const bufferRaw = d.bufferPct.trim();
      const freshRaw = d.freshPct.trim();
      const bufferPct = bufferRaw === "" ? null : Number(bufferRaw);
      const freshPct = freshRaw === "" ? null : Number(freshRaw);
      return {
        gender: b.gender,
        age_segment: b.ageSegment,
        base_capacity: Number.isFinite(base) && base >= 0 ? Math.round(base) : 0,
        buffer_pct: bufferPct !== null && Number.isFinite(bufferPct) && bufferPct > 0 ? bufferPct : null,
        fresh_pct: freshPct !== null && Number.isFinite(freshPct) && freshPct >= 0 && freshPct <= 100 ? freshPct : null,
      };
    });
    setStatus({ kind: "idle" });
    startTransition(async () => {
      try {
        await setStoreDisplayCapacity({ store_id: storeId, values });
        setStatus({ kind: "done" });
        router.refresh();
      } catch (err) {
        setStatus({ kind: "error", message: err instanceof Error ? err.message : "Save failed." });
      }
    });
  }

  return (
    <div className="border border-line-soft p-4">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-semibold">{storeName}</span>
        <span className="text-[11px] text-ink-3">{storeId}</span>
      </div>

      {/* Total planned capacity — rollup across the 4 segment blocks below, so there's a
          single at-a-glance number per store, not just 4 separate ones. */}
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 border-l-2 border-accent bg-surface-2 px-3 py-2 text-[12px]">
        <span>
          <span className="text-ink-3">Total base capacity</span>{" "}
          <span className="font-mono font-semibold text-ink">{fmt(totals.baseCapacity)}</span>
        </span>
        <span>
          <span className="text-ink-3">Total buffered (planned)</span>{" "}
          <span className="font-mono text-ink-2">{fmt(totals.bufferedCapacity)}</span>
        </span>
        <span>
          <span className="text-ink-3">Total Fresh</span>{" "}
          <span className="font-mono text-ink-2">{fmt(totals.freshCapacity)}</span>
        </span>
        <span>
          <span className="text-ink-3">Total EOSS</span>{" "}
          <span className="font-mono text-ink-2">{fmt(totals.eossCapacity)}</span>
        </span>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {blocks.map((b) => {
          const key = `${b.gender}-${b.ageSegment}`;
          const editorName = b.updatedBy ? namesByUserId[b.updatedBy] ?? "Unknown" : null;
          const draft = drafts[key] ?? emptyDraft;
          return (
            <div key={key} className="border border-line-soft p-3">
              <div className="text-[12.5px] font-semibold text-ink-2">{b.label}</div>

              {canEdit ? (
                <label className="mt-2 flex items-center gap-2 text-[12px] text-ink-3">
                  Base capacity
                  <input
                    type="number"
                    min={0}
                    inputMode="numeric"
                    value={draft.base}
                    onChange={(e) => updateDraft(key, "base", e.target.value)}
                    className="min-h-[32px] w-24 border border-line bg-surface px-2 py-1 text-sm text-ink"
                  />
                </label>
              ) : (
                <div className="mt-2 text-[12px] text-ink-3">
                  Base capacity <span className="font-mono text-ink-2">{fmt(b.baseCapacity)}</span>
                </div>
              )}

              {canEdit ? (
                <div className="mt-2 flex flex-wrap items-center gap-3 text-[12px] text-ink-3">
                  <label className="flex items-center gap-2">
                    Buffer %
                    <input
                      type="number"
                      min={0}
                      step="0.1"
                      inputMode="decimal"
                      placeholder={String(DEFAULT_BUFFER_PCT)}
                      value={draft.bufferPct}
                      onChange={(e) => updateDraft(key, "bufferPct", e.target.value)}
                      className="min-h-[32px] w-20 border border-line bg-surface px-2 py-1 text-sm text-ink"
                    />
                  </label>
                  <label className="flex items-center gap-2">
                    Fresh %
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step="0.1"
                      inputMode="decimal"
                      placeholder={String(DEFAULT_FRESH_PCT)}
                      value={draft.freshPct}
                      onChange={(e) => updateDraft(key, "freshPct", e.target.value)}
                      className="min-h-[32px] w-20 border border-line bg-surface px-2 py-1 text-sm text-ink"
                    />
                  </label>
                  <span className="text-[11px]">(EOSS % = 100 − Fresh %; blank = default)</span>
                </div>
              ) : (
                <div className="mt-2 text-[11px] text-ink-3">
                  Buffer {b.bufferPct}% · Fresh {b.freshPct}% / EOSS {b.eossPct}%
                  {b.bufferPctOverride === null && b.freshPctOverride === null && " (default)"}
                </div>
              )}

              <div className="mt-2 text-[11.5px] text-ink-3">
                Buffered (planned) <span className="font-mono text-ink-2">{fmt(b.bufferedCapacity)}</span>
              </div>
              <div className="mt-1 text-[11.5px] text-ink-3">
                Fresh <span className="font-mono text-ink-2">{fmt(b.freshCapacity)}</span> · EOSS{" "}
                <span className="font-mono text-ink-2">{fmt(b.eossCapacity)}</span>
              </div>

              <div className="mt-2 text-[10.5px] text-ink-3">
                {editorName ? (
                  <>
                    Last edited by <span className="text-ink-2">{editorName}</span> on {fmtWhen(b.updatedAt)}
                  </>
                ) : (
                  "Not yet set"
                )}
              </div>
            </div>
          );
        })}
      </div>

      {canEdit && (
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={onSave}
            disabled={isPending}
            className="min-h-[34px] bg-accent px-4 py-1.5 text-[13px] font-semibold text-white disabled:opacity-60"
          >
            {isPending ? "Saving…" : `Save ${storeName} capacity`}
          </button>
          {status.kind === "done" && <span className="text-[12px] text-good">Saved.</span>}
          {status.kind === "error" && <span className="text-[12px] text-crit">{status.message}</span>}
        </div>
      )}
    </div>
  );
}
