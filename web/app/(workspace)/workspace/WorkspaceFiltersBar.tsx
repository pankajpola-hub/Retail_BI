"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { updateWorkspaceFilters } from "@/lib/workspace/actions";

/**
 * Store scope as a searchable checkbox popover (same interaction pattern as
 * components/ui/StoreFilter.tsx's MultiSelectFilter — draft state while open,
 * committed once on close/Done), not a native `<select multiple>`. A plain
 * multiselect requires ctrl/cmd-click to pick more than one option, which
 * almost nobody discovers on their own.
 *
 * Everything below the search box is sized for the 100+ store deployment
 * target, not the 2-store dev fixture: the option list is capped rather than
 * rendered whole, bulk actions are scoped to the search result, and the
 * selection collapses to a count once it stops being readable as chips.
 */

/**
 * Rows rendered per "page" of the option list. Cap-and-reveal instead of true
 * virtualization: the search box keeps the working set small (a store the user
 * wants is one or two keystrokes away), so the only job left is to stop an
 * unfiltered 500-store list from materializing 500 DOM rows. A real virtualizer
 * would buy windowed scrolling of the *full* list, but it needs either a
 * dependency or a hand-rolled fixed-row-height/scroll-offset implementation —
 * neither of which pays for itself when the interaction we're optimizing is
 * "type three letters, click one row." If store counts ever reach the point
 * where users genuinely scroll thousands of unfiltered rows, revisit.
 */
const ROW_CAP = 50;

/** Above this many selections, individual chips stop being readable as a set. */
const CHIP_LIMIT = 5;

export function WorkspaceFiltersBar({
  workspaceId,
  stores,
  initialStoreIds,
  initialFrom,
  initialTo,
}: {
  workspaceId: string;
  stores: { store_id: string; store_name: string }[];
  initialStoreIds: string[];
  initialFrom: string;
  initialTo: string;
}) {
  const [storeIds, setStoreIds] = useState<string[]>(initialStoreIds);
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string[]>(initialStoreIds);
  const [query, setQuery] = useState("");
  const [cap, setCap] = useState(ROW_CAP);
  const [isPending, startTransition] = useTransition();
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const storeName = (id: string) => stores.find((s) => s.store_id === id)?.store_name ?? id;

  // Matching on store_id as well as name because the id is what appears in
  // uploaded reports and in support conversations ("what's up with BO-004?").
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return stores;
    return stores.filter(
      (s) => s.store_name.toLowerCase().includes(q) || s.store_id.toLowerCase().includes(q),
    );
  }, [stores, query]);

  const visible = filtered.slice(0, cap);
  const hiddenCount = filtered.length - visible.length;

  function apply(nextStoreIds: string[], nextFrom: string, nextTo: string) {
    startTransition(async () => {
      await updateWorkspaceFilters(workspaceId, { storeIds: nextStoreIds, from: nextFrom, to: nextTo });
    });
  }

  function closeAndCommit() {
    setOpen(false);
    setStoreIds(pending);
    apply(pending, from, to);
  }

  useEffect(() => {
    if (!open) return;
    function onOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) closeAndCommit();
    }
    // Bound to document rather than the popover so Escape still commits while
    // focus sits in the search input.
    function onEscape(e: KeyboardEvent) {
      if (e.key === "Escape") closeAndCommit();
    }
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("keydown", onEscape);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pending]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  // Toggling from the trigger resets the draft to the committed selection, as
  // it always has — the search text and row cap reset with it so the popover
  // never reopens mid-scroll into someone else's query.
  function togglePicker() {
    setPending(storeIds);
    setQuery("");
    setCap(ROW_CAP);
    setOpen((v) => !v);
  }

  function toggleStore(id: string) {
    setPending((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]));
  }

  /**
   * Bulk actions deliberately act on the search result, never on `stores`. At
   * 400 stores a "Select all" that silently means "all 400" is a footgun; with
   * an empty search box the filtered set *is* everything, which is the only
   * case where the two readings coincide.
   */
  function selectAllFiltered() {
    setPending((prev) => Array.from(new Set([...prev, ...filtered.map((s) => s.store_id)])));
  }

  function clearFiltered() {
    const drop = new Set(filtered.map((s) => s.store_id));
    setPending((prev) => prev.filter((id) => !drop.has(id)));
  }

  function removeStoreChip(id: string) {
    const next = storeIds.filter((v) => v !== id);
    setStoreIds(next);
    setPending(next);
    apply(next, from, to);
  }

  function clearAllStores() {
    setStoreIds([]);
    setPending([]);
    apply([], from, to);
  }

  function handleDateBlur() {
    apply(storeIds, from, to);
  }

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border border-line-soft bg-surface px-4 py-3">
      <div ref={containerRef} className="relative flex flex-wrap items-center gap-2">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Stores</span>
        {storeIds.length === 0 ? (
          <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[12px] text-ink-3">All stores</span>
        ) : storeIds.length <= CHIP_LIMIT ? (
          storeIds.map((id) => (
            <span
              key={id}
              className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-[12px] font-medium text-accent-ink"
            >
              {storeName(id)}
              <button
                type="button"
                onClick={() => removeStoreChip(id)}
                aria-label={`Remove ${storeName(id)}`}
                className="text-accent-ink/70 hover:text-accent-ink"
              >
                ✕
              </button>
            </span>
          ))
        ) : (
          // Past the chip limit the individual names stop carrying information
          // and just consume the bar. Per-store deselection is still available
          // inside the popover, which is where it belongs at this size anyway.
          <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-[12px] font-medium text-accent-ink">
            {storeIds.length} stores selected
            <button
              type="button"
              onClick={clearAllStores}
              aria-label="Clear all selected stores"
              className="text-accent-ink/70 hover:text-accent-ink"
            >
              Clear all
            </button>
          </span>
        )}
        <button
          type="button"
          onClick={togglePicker}
          aria-haspopup="listbox"
          aria-expanded={open}
          className="inline-flex min-h-[30px] items-center gap-1 rounded-full border border-dashed border-line px-2.5 text-[12px] text-ink-3 hover:border-accent hover:text-accent"
        >
          + Add store
        </button>

        {open && (
          <div className="absolute left-0 top-full z-20 mt-2 flex max-h-80 w-64 flex-col rounded-md border border-line bg-surface p-2 shadow-lg">
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setCap(ROW_CAP);
              }}
              placeholder="Search stores…"
              aria-label="Search stores by name or ID"
              className="min-h-[30px] w-full rounded border border-line bg-surface px-2 py-1 text-[12.5px] text-ink-2"
            />

            <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px]">
              <button
                type="button"
                onClick={selectAllFiltered}
                disabled={filtered.length === 0}
                className="font-semibold text-accent hover:underline disabled:text-ink-3 disabled:no-underline"
              >
                Select all {filtered.length} {query.trim() ? "matching" : "stores"}
              </button>
              <button
                type="button"
                onClick={clearFiltered}
                disabled={filtered.length === 0}
                className="font-semibold text-ink-3 hover:text-ink-2 hover:underline disabled:no-underline"
              >
                {query.trim() ? "Clear matching" : "Clear"}
              </button>
            </div>

            <div role="listbox" aria-multiselectable aria-label="Stores" className="mt-1.5 flex-1 overflow-y-auto">
              {visible.map((s) => (
                <label
                  key={s.store_id}
                  className="flex items-center gap-2 rounded px-2 py-1.5 text-[12.5px] text-ink-2 hover:bg-surface-2"
                >
                  <input
                    type="checkbox"
                    checked={pending.includes(s.store_id)}
                    onChange={() => toggleStore(s.store_id)}
                  />
                  {s.store_name}
                </label>
              ))}
              {filtered.length === 0 && (
                <p className="px-2 py-1.5 text-[12.5px] text-ink-3">No stores match “{query.trim()}”.</p>
              )}
              {hiddenCount > 0 && (
                <div className="px-2 py-1.5 text-[11px] text-ink-3">
                  Showing {visible.length} of {filtered.length} — refine your search
                  <button
                    type="button"
                    onClick={() => setCap((c) => c + ROW_CAP)}
                    className="ml-1.5 font-semibold text-accent hover:underline"
                  >
                    Show {Math.min(ROW_CAP, hiddenCount)} more
                  </button>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={closeAndCommit}
              className="mt-1.5 w-full rounded border-t border-line-soft pt-1.5 text-center text-[11px] font-semibold text-accent hover:underline"
            >
              Done
            </button>
          </div>
        )}
      </div>

      <div className="h-6 w-px bg-line-soft" aria-hidden />

      <div className="flex items-center gap-2">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Period</span>
        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          onBlur={handleDateBlur}
          className="min-h-[30px] rounded border border-line bg-surface px-2 py-1 text-[12.5px] text-ink-2"
        />
        <span className="text-ink-3">→</span>
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          onBlur={handleDateBlur}
          className="min-h-[30px] rounded border border-line bg-surface px-2 py-1 text-[12.5px] text-ink-2"
        />
      </div>

      {isPending && <span className="text-[11px] text-ink-3">Applying…</span>}
    </div>
  );
}
