"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";

type Store = { store_id: string; store_name: string };

/**
 * Narrows a page to one store. This is a convenience filter within what the
 * caller is ALREADY allowed to see — the underlying views filter by
 * core.fn_user_store_ids() regardless, so picking a store here can never
 * widen access (an ebo_manager only ever gets their own store in this list).
 *
 * allowAll=false for pages where "all stores" is meaningless — footfall is
 * entered against one specific store, so there's no aggregate to pick.
 */
export function StoreFilter({
  stores,
  selected,
  allowAll = true,
  label,
}: {
  stores: Store[];
  selected: string;
  allowAll?: boolean;
  label?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function onChange(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (allowAll && value === "all") params.delete("store");
    else params.set("store", value);
    // Deliberately push() ONLY — no refresh(). refresh() doesn't take a
    // target URL, it just means "refetch whatever route the router
    // currently considers active"; called right after push() (even inside
    // the same startTransition — tried that, still raced) it can act on the
    // OLD route before push()'s navigation has committed, silently
    // reverting the just-applied filter back to unfiltered. Reproduced live
    // and confirmed via network trace: the ?store=BO-003 RSC fetch actually
    // completed successfully, but the final committed URL still snapped
    // back to no ?store — refresh() won the race after the fact. push()
    // alone is sufficient here: every filter change produces a genuinely
    // new URL (different searchParams), which is always a cache miss in the
    // client Router Cache, so Next already fetches fresh data for it.
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <label className="flex items-center gap-2">
      {label && <span className="text-[12px] text-ink-3">{label}</span>}
      <select
        value={selected}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-[36px] border border-line bg-surface px-3 py-1.5 text-[13px] text-ink-2"
        aria-label={label ?? "Filter by store"}
      >
        {allowAll && <option value="all">All stores</option>}
        {stores.map((s) => (
          <option key={s.store_id} value={s.store_id}>
            {s.store_name}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Generic sibling of StoreFilter for narrowing a page by any single-value
 * URL search param backed by a plain string option list (Gender,
 * Subcategory, ...) — same "push a search param, let the server component
 * re-fetch" pattern, just not tied to the {store_id, store_name} shape.
 * allValue defaults to removing the param entirely (matches StoreFilter's
 * "all" -> delete behavior) so an unset filter never appears as a real
 * value in the URL.
 */
export function AttributeFilter({
  paramName,
  options,
  selected,
  label,
  allLabel = "All",
}: {
  paramName: string;
  options: string[];
  selected: string;
  label?: string;
  allLabel?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function onChange(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === "") params.delete(paramName);
    else params.set(paramName, value);
    // See StoreFilter's onChange above for why there's no router.refresh().
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <label className="flex items-center gap-2">
      {label && <span className="text-[12px] text-ink-3">{label}</span>}
      <select
        value={selected}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-[36px] border border-line bg-surface px-3 py-1.5 text-[13px] text-ink-2"
        aria-label={label ?? `Filter by ${paramName}`}
      >
        <option value="">{allLabel}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Multi-select checkbox dropdown for a comma-separated URL search param —
 * "pick any number of X" (store, gender, subcategory, category, ...), as
 * opposed to StoreFilter/AttributeFilter's pick-one-or-all. No selection
 * (empty array) means the param is removed entirely, same "unfiltered ==
 * no param in the URL" convention as the single-select filters above.
 *
 * Deliberately a checkbox popover rather than a native <select multiple> —
 * a plain multi-select requires ctrl/cmd-click to pick more than one option,
 * which most users never discover; a popover with visible checkboxes and an
 * "N selected" summary button is a much more obvious affordance for the same
 * behavior, at the cost of a bit more code.
 */
export function MultiSelectFilter({
  paramName,
  options,
  labels,
  selected,
  label,
  allLabel = "All",
  clearAsEmptyParam = false,
}: {
  paramName: string;
  options: string[];
  /**
   * Display text per option value, defaults to the value itself for any key
   * not present. A plain object, not a function — this component is a
   * Client Component and its parent Server Component page can't pass a
   * function prop across that boundary (Next.js serializes props between
   * them), so callers precompute a value -> label map instead.
   */
  labels?: Record<string, string>;
  selected: string[];
  label?: string;
  allLabel?: string;
  /**
   * When true, clearing every checkbox writes `?param=` (present, empty)
   * instead of deleting the param outright. Needed wherever the page treats
   * an ABSENT param as "apply a default filter" (see /targets' Gender and
   * Category) — without this, clicking "Clear" would just fall back to the
   * default again instead of actually showing everything.
   */
  clearAsEmptyParam?: boolean;
}) {
  const labelFor = (value: string) => labels?.[value] ?? value;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  // Checking boxes only updates this LOCAL draft — nothing hits the server
  // until the dropdown closes (outside click / Escape / Apply). Committing
  // on every checkbox click was the actual cause of "multi-select feels
  // slow": picking 3 stores meant 3 full page navigations + server
  // re-fetches, one per click, instead of one.
  const [pending, setPending] = useState<string[]>(selected);
  const containerRef = useRef<HTMLDivElement>(null);

  function commit(values: string[]) {
    // The checkbox popover's Apply/outside-click commit is a <button>/click
    // deep in a dropdown, not a link or <select> — the closest listeners
    // TopProgressBar already has — so it needs its own explicit signal.
    window.dispatchEvent(new Event("progressbar:start"));
    const params = new URLSearchParams(searchParams.toString());
    if (values.length === 0) {
      if (clearAsEmptyParam) params.set(paramName, "");
      else params.delete(paramName);
    } else params.set(paramName, values.join(","));
    // See StoreFilter's onChange above for why there's no router.refresh()
    // — this is the component behind the "Sinhgad Road still shows Undri's
    // numbers" report: the filter WAS applying (confirmed live: URL
    // correctly became ?store=BO-003), then the bare refresh() won a race
    // a moment later and silently reverted the URL back to unfiltered.
    router.push(`${pathname}?${params.toString()}`);
  }

  function openDropdown() {
    setPending(selected); // start the draft from whatever's actually committed
    setOpen(true);
  }

  function closeAndCommit() {
    setOpen(false);
    const changed =
      pending.length !== selected.length || pending.some((v) => !selected.includes(v));
    if (changed) commit(pending);
  }

  useEffect(() => {
    if (!open) return;
    function onOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) closeAndCommit();
    }
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

  function toggle(value: string) {
    setPending((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
  }

  const summary =
    selected.length === 0
      ? allLabel
      : selected.length === 1
        ? labelFor(selected[0] as string)
        : `${selected.length} selected`;

  return (
    <div ref={containerRef} className="relative flex items-center gap-2">
      {label && <span className="text-[12px] text-ink-3">{label}</span>}
      <button
        type="button"
        onClick={() => (open ? closeAndCommit() : openDropdown())}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="min-h-[36px] min-w-[120px] border border-line bg-surface px-3 py-1.5 text-left text-[13px] text-ink-2"
      >
        {summary}
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={label ?? `Filter by ${paramName}`}
          className="absolute left-0 top-full z-20 mt-1 max-h-64 w-max min-w-[200px] overflow-y-auto border border-line bg-surface p-2 shadow-md"
        >
          <div className="flex items-center justify-between gap-3 border-b border-line-soft pb-1.5 mb-1.5">
            <button type="button" onClick={() => setPending([])} className="text-[11px] text-accent hover:underline">
              Clear ({allLabel})
            </button>
            <button type="button" onClick={() => setPending(options)} className="text-[11px] text-accent hover:underline">
              Select all
            </button>
          </div>
          {options.map((o) => (
            <label key={o} className="flex items-center gap-2 py-1 text-[12.5px] text-ink-2 hover:bg-surface-2">
              <input type="checkbox" checked={pending.includes(o)} onChange={() => toggle(o)} />
              {labelFor(o)}
            </label>
          ))}
          <button
            type="button"
            onClick={closeAndCommit}
            className="mt-1.5 w-full border-t border-line-soft pt-1.5 text-center text-[11px] font-semibold text-accent hover:underline"
          >
            Apply
          </button>
        </div>
      )}
    </div>
  );
}
