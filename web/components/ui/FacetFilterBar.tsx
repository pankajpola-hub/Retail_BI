"use client";

import { useMemo, useRef, useState, useEffect } from "react";
import { useProgressTransition } from "@/components/ui/useProgressTransition";
import { listMySavedViews, createSavedView, deleteSavedView } from "@/lib/savedViews/actions";

/**
 * Generic, reusable Excel/Airtable-style faceted filtering engine — a
 * React port of the Shopify image-uploader project's Checklist screen
 * (D:\Py\Shopify image uploader\server\static\index.html, ~lines
 * 2302-2900): same cascading-facet-counts algorithm, chips, advanced
 * filter builder, group-by. That reference is vanilla JS operating on an
 * in-memory row array with no page reloads — this is the same model,
 * typed and reusable across pages. First caller:
 * app/(replenishment)/movement/ReplenishmentFacetedContent.tsx.
 *
 * Everything here operates on a full, already-loaded row array — the
 * caller is responsible for fetching the complete (unpaginated) dataset
 * server-side and handing it to this component once; there is no server
 * round-trip for any filter/search/group/save action.
 */

export type FacetDef<T> = {
  key: string;
  label: string;
  get: (row: T) => string | null;
};

export type AdvField<T> = {
  key: string;
  label: string;
  get: (row: T) => string | number | null;
  numeric?: boolean;
};

const TEXT_OPS = [
  { key: "contains", label: "contains" },
  { key: "not_contains", label: "does not contain" },
  { key: "eq", label: "is" },
  { key: "ne", label: "is not" },
] as const;
const NUM_OPS = [
  { key: "eq", label: "=" },
  { key: "ne", label: "≠" },
  { key: "gt", label: ">" },
  { key: "lt", label: "<" },
  { key: "gte", label: "≥" },
  { key: "lte", label: "≤" },
  { key: "blank", label: "is blank" },
  { key: "not_blank", label: "is not blank" },
] as const;

export type Condition = { field: string; op: string; value: string };
export type FacetFilterState = {
  search: string;
  facets: Record<string, string[]>;
  conditions: Condition[];
  groupBy: string[];
};

export function emptyFilterState(): FacetFilterState {
  return { search: "", facets: {}, conditions: [], groupBy: [] };
}

function selectedSet(state: FacetFilterState, key: string): Set<string> {
  return new Set(state.facets[key] ?? []);
}

function rowMatchesFacets(
  row: unknown,
  facets: FacetDef<unknown>[],
  state: FacetFilterState,
  exceptKey: string | null
): boolean {
  for (const f of facets) {
    if (f.key === exceptKey) continue;
    const sel = selectedSet(state, f.key);
    if (sel.size === 0) continue;
    const v = f.get(row);
    if (v === null || !sel.has(v)) return false;
  }
  return true;
}

function rowMatchesConditions(row: unknown, advFields: AdvField<unknown>[], conditions: Condition[]): boolean {
  return conditions.every((c) => {
    if (!c.field) return true;
    const f = advFields.find((x) => x.key === c.field);
    if (!f) return true;
    const raw = f.get(row);
    if (f.numeric) {
      if (c.op === "blank") return raw === null;
      if (c.op === "not_blank") return raw !== null;
      const a = Number(raw);
      const b = Number(c.value);
      if (raw === null || Number.isNaN(a) || Number.isNaN(b)) return false;
      switch (c.op) {
        case "eq":
          return a === b;
        case "ne":
          return a !== b;
        case "gt":
          return a > b;
        case "lt":
          return a < b;
        case "gte":
          return a >= b;
        case "lte":
          return a <= b;
        default:
          return true;
      }
    }
    const a = String(raw ?? "").toLowerCase();
    const b = String(c.value ?? "").toLowerCase();
    if (!b) return true;
    switch (c.op) {
      case "contains":
        return a.includes(b);
      case "not_contains":
        return !a.includes(b);
      case "eq":
        return a === b;
      case "ne":
        return a !== b;
      default:
        return true;
    }
  });
}

function rowMatchesSearch<T>(row: T, searchFields: AdvField<T>[], q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return searchFields.some((f) => String(f.get(row) ?? "").toLowerCase().includes(needle));
}

/** Rows passing search/conditions/every facet EXCEPT `exceptKey` — the base set a facet's own option list and counts are computed from, so a facet never hides its own current picks. */
function rowsExcludingFacet<T>(
  rows: T[],
  facets: FacetDef<T>[],
  advFields: AdvField<T>[],
  state: FacetFilterState,
  exceptKey: string | null
): T[] {
  return rows.filter(
    (r) =>
      rowMatchesSearch(r, advFields, state.search.trim().toLowerCase()) &&
      rowMatchesConditions(r, advFields as AdvField<unknown>[], state.conditions) &&
      rowMatchesFacets(r, facets as FacetDef<unknown>[], state, exceptKey)
  );
}

export function applyFacetFilter<T>(rows: T[], facets: FacetDef<T>[], advFields: AdvField<T>[], state: FacetFilterState): T[] {
  return rowsExcludingFacet(rows, facets, advFields, state, null);
}

function facetOptionCounts<T>(rows: T[], facets: FacetDef<T>[], advFields: AdvField<T>[], state: FacetFilterState, facet: FacetDef<T>) {
  const base = rowsExcludingFacet(rows, facets, advFields, state, facet.key);
  const counts = new Map<string, number>();
  for (const r of base) {
    const v = facet.get(r);
    if (v === null || v === "") continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  // A currently-selected value stays listed even at 0 rows, so the user can
  // always see/remove their own picks.
  for (const v of selectedSet(state, facet.key)) if (!counts.has(v)) counts.set(v, 0);
  return counts;
}

export function FacetFilterBar<T>({
  pageKey,
  rows,
  facets,
  advFields,
  groupByOptions,
  state,
  onChange,
}: {
  pageKey: string;
  rows: T[];
  facets: FacetDef<T>[];
  advFields: AdvField<T>[];
  groupByOptions: { key: string; label: string }[];
  state: FacetFilterState;
  onChange: (next: FacetFilterState) => void;
}) {
  const [openFacet, setOpenFacet] = useState<string | null>(null);
  const [facetSearch, setFacetSearch] = useState<Record<string, string>>({});
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [savedViews, setSavedViews] = useState<{ id: string; name: string; state: unknown }[]>([]);
  const [saveName, setSaveName] = useState("");
  const [isPending, startTransition] = useProgressTransition();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listMySavedViews(pageKey).then((views) => setSavedViews(views.map((v) => ({ id: v.id, name: v.name, state: v.state }))));
  }, [pageKey]);

  useEffect(() => {
    if (!openFacet) return;
    function onOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpenFacet(null);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [openFacet]);

  function toggleFacetValue(key: string, value: string) {
    const cur = new Set(state.facets[key] ?? []);
    if (cur.has(value)) cur.delete(value);
    else cur.add(value);
    onChange({ ...state, facets: { ...state.facets, [key]: [...cur] } });
  }
  function setFacetValues(key: string, values: string[]) {
    onChange({ ...state, facets: { ...state.facets, [key]: values } });
  }
  function clearAll() {
    onChange(emptyFilterState());
  }
  function addCondition() {
    const first = advFields[0];
    if (!first) return;
    onChange({ ...state, conditions: [...state.conditions, { field: first.key, op: first.numeric ? "eq" : "contains", value: "" }] });
  }
  function updateCondition(i: number, patch: Partial<Condition>) {
    const next = state.conditions.slice();
    next[i] = { ...next[i]!, ...patch };
    onChange({ ...state, conditions: next });
  }
  function removeCondition(i: number) {
    onChange({ ...state, conditions: state.conditions.filter((_, idx) => idx !== i) });
  }
  function toggleGroupBy(key: string) {
    const cur = state.groupBy;
    onChange({ ...state, groupBy: cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key] });
  }

  function handleSaveView() {
    const name = saveName.trim();
    if (!name) return;
    startTransition(async () => {
      await createSavedView(pageKey, name, state);
      const views = await listMySavedViews(pageKey);
      setSavedViews(views.map((v) => ({ id: v.id, name: v.name, state: v.state })));
      setSaveName("");
    });
  }
  function handleLoadView(id: string) {
    const view = savedViews.find((v) => v.id === id);
    if (view) onChange(view.state as FacetFilterState);
  }
  function handleDeleteView(id: string) {
    startTransition(async () => {
      await deleteSavedView(id);
      setSavedViews((prev) => prev.filter((v) => v.id !== id));
    });
  }

  const activeChips: { label: string; onRemove: () => void }[] = [];
  for (const f of facets) {
    for (const v of state.facets[f.key] ?? []) {
      activeChips.push({ label: `${f.label}: ${v}`, onRemove: () => toggleFacetValue(f.key, v) });
    }
  }
  if (state.search.trim()) {
    activeChips.push({ label: `Search: ${state.search.trim()}`, onRemove: () => onChange({ ...state, search: "" }) });
  }
  state.conditions.forEach((c, i) => {
    if (!c.field) return;
    const f = advFields.find((x) => x.key === c.field);
    const ops = f?.numeric ? NUM_OPS : TEXT_OPS;
    const op = ops.find((o) => o.key === c.op);
    activeChips.push({
      label: `${f?.label ?? c.field} ${op?.label ?? c.op} ${c.value}`.trim(),
      onRemove: () => removeCondition(i),
    });
  });

  return (
    <div ref={containerRef} className="mb-3 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={state.search}
          onChange={(e) => onChange({ ...state, search: e.target.value })}
          placeholder="Quick search…"
          className="min-h-[32px] w-56 rounded-md border border-line bg-surface px-2.5 py-1 text-[12.5px] text-ink-2"
        />

        {facets.map((facet) => {
          const n = (state.facets[facet.key] ?? []).length;
          const isOpen = openFacet === facet.key;
          return (
            <div key={facet.key} className="relative">
              <button
                type="button"
                onClick={() => setOpenFacet(isOpen ? null : facet.key)}
                className={`flex min-h-[32px] items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12.5px] ${
                  n > 0 ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-ink-2 hover:bg-surface-2"
                }`}
              >
                {facet.label}
                {n > 0 ? ` (${n})` : ""}
                <span className="text-[9px] opacity-60">▼</span>
              </button>
              {isOpen && (
                <FacetPanel
                  facet={facet}
                  rows={rows}
                  facets={facets}
                  advFields={advFields}
                  state={state}
                  search={facetSearch[facet.key] ?? ""}
                  onSearchChange={(v) => setFacetSearch((prev) => ({ ...prev, [facet.key]: v }))}
                  onToggle={(v) => toggleFacetValue(facet.key, v)}
                  onSetAll={(values) => setFacetValues(facet.key, values)}
                  onClear={() => setFacetValues(facet.key, [])}
                />
              )}
            </div>
          );
        })}

        {advFields.length > 0 && (
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className={`min-h-[32px] rounded-md border px-2.5 py-1 text-[12.5px] ${
              state.conditions.length > 0 ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-ink-2 hover:bg-surface-2"
            }`}
          >
            Advanced{state.conditions.length > 0 ? ` (${state.conditions.length})` : ""}
          </button>
        )}

        {groupByOptions.length > 0 && (
          <div className="flex items-center gap-1.5 text-[12px] text-ink-3">
            Group by
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) toggleGroupBy(e.target.value);
                e.target.value = "";
              }}
              className="min-h-[32px] rounded-md border border-line bg-surface px-1.5 py-1 text-[12px] text-ink-2"
            >
              <option value="">+ Add level…</option>
              {groupByOptions
                .filter((g) => !state.groupBy.includes(g.key))
                .map((g) => (
                  <option key={g.key} value={g.key}>
                    {g.label}
                  </option>
                ))}
            </select>
            {state.groupBy.map((key, i) => {
              const g = groupByOptions.find((x) => x.key === key);
              return (
                <span key={key} className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-ink-2">
                  {i > 0 ? "→ " : ""}
                  {g?.label ?? key}
                  <button type="button" onClick={() => toggleGroupBy(key)} className="font-bold opacity-60 hover:opacity-100">
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) handleLoadView(e.target.value);
              e.target.value = "";
            }}
            className="min-h-[32px] rounded-md border border-line bg-surface px-1.5 py-1 text-[12px] text-ink-2"
          >
            <option value="">Saved views…</option>
            {savedViews.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder="View name…"
            className="min-h-[32px] w-32 rounded-md border border-line bg-surface px-2 py-1 text-[12px] text-ink-2"
          />
          <button
            type="button"
            disabled={!saveName.trim() || isPending}
            onClick={handleSaveView}
            className="min-h-[32px] rounded-md border border-line px-2.5 py-1 text-[12px] text-ink-2 hover:bg-surface-2 disabled:opacity-40"
          >
            Save view
          </button>
        </div>
      </div>

      {showAdvanced && (
        <div className="rounded-md border border-line-soft bg-surface-2 p-3">
          <div className="flex flex-col gap-2">
            {state.conditions.map((c, i) => {
              const f = advFields.find((x) => x.key === c.field);
              const ops = f?.numeric ? NUM_OPS : TEXT_OPS;
              const noValue = c.op === "blank" || c.op === "not_blank";
              return (
                <div key={i} className="flex items-center gap-2 text-[12.5px]">
                  <select
                    value={c.field}
                    onChange={(e) => {
                      const nf = advFields.find((x) => x.key === e.target.value);
                      updateCondition(i, { field: e.target.value, op: nf?.numeric ? "eq" : "contains" });
                    }}
                    className="min-h-[30px] rounded-md border border-line bg-surface px-1.5 py-1"
                  >
                    {advFields.map((x) => (
                      <option key={x.key} value={x.key}>
                        {x.label}
                      </option>
                    ))}
                  </select>
                  <select
                    value={c.op}
                    onChange={(e) => updateCondition(i, { op: e.target.value })}
                    className="min-h-[30px] rounded-md border border-line bg-surface px-1.5 py-1"
                  >
                    {ops.map((o) => (
                      <option key={o.key} value={o.key}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <input
                    type={f?.numeric ? "number" : "text"}
                    value={c.value}
                    disabled={noValue}
                    onChange={(e) => updateCondition(i, { value: e.target.value })}
                    placeholder="value"
                    className="min-h-[30px] w-32 rounded-md border border-line bg-surface px-2 py-1 disabled:opacity-40"
                  />
                  <button type="button" onClick={() => removeCondition(i)} className="text-ink-3 hover:text-crit">
                    ×
                  </button>
                </div>
              );
            })}
            <button type="button" onClick={addCondition} className="w-fit text-[12px] text-accent hover:underline">
              + Add condition
            </button>
          </div>
        </div>
      )}

      {activeChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {activeChips.map((chip, i) => (
            <span key={i} className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11.5px] text-ink-2">
              {chip.label}
              <button type="button" onClick={chip.onRemove} className="font-bold opacity-60 hover:opacity-100">
                ×
              </button>
            </span>
          ))}
          <button type="button" onClick={clearAll} className="text-[11.5px] text-accent hover:underline">
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}

export type GroupHeaderRow = { __groupHeader: true; id: string; label: string; level: number; count: number };

/**
 * Interleaves synthetic group-header rows into `rows`, nested per
 * `groupBy` order (e.g. Style → Colour → Priority → Action) — the
 * Community-tier-compatible stand-in for AG Grid's (Enterprise-only) Row
 * Grouping: the caller renders these via AG Grid's `isFullWidthRow` +
 * `fullWidthCellRenderer`, real Row entries render through the normal
 * column defs unchanged. Rows are stably sorted by the group keys first so
 * each group's rows stay contiguous; a column-header click-sort still
 * re-sorts the full array afterward, so grouping and column sort are best
 * used one at a time rather than combined.
 */
export function buildGroupedRows<T>(
  rows: T[],
  groupBy: string[],
  keyGetters: Record<string, (row: T) => string>
): (T | GroupHeaderRow)[] {
  if (groupBy.length === 0) return rows;

  function groupLevel(input: T[], level: number, prefix: string): (T | GroupHeaderRow)[] {
    if (level >= groupBy.length) return input;
    const key = groupBy[level]!;
    const getter = keyGetters[key];
    if (!getter) return groupLevel(input, level + 1, prefix);

    const buckets = new Map<string, T[]>();
    for (const row of input) {
      const v = getter(row) || "(blank)";
      if (!buckets.has(v)) buckets.set(v, []);
      buckets.get(v)!.push(row);
    }
    const sortedKeys = [...buckets.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    const out: (T | GroupHeaderRow)[] = [];
    for (const groupValue of sortedKeys) {
      const bucketRows = buckets.get(groupValue)!;
      const id = `${prefix}/${key}:${groupValue}`;
      out.push({ __groupHeader: true, id, label: groupValue, level, count: bucketRows.length });
      out.push(...groupLevel(bucketRows, level + 1, id));
    }
    return out;
  }

  return groupLevel(rows, 0, "root");
}

function FacetPanel<T>({
  facet,
  rows,
  facets,
  advFields,
  state,
  search,
  onSearchChange,
  onToggle,
  onSetAll,
  onClear,
}: {
  facet: FacetDef<T>;
  rows: T[];
  facets: FacetDef<T>[];
  advFields: AdvField<T>[];
  state: FacetFilterState;
  search: string;
  onSearchChange: (v: string) => void;
  onToggle: (v: string) => void;
  onSetAll: (values: string[]) => void;
  onClear: () => void;
}) {
  const counts = useMemo(() => facetOptionCounts(rows, facets, advFields, state, facet), [rows, facets, advFields, state, facet]);
  const selected = selectedSet(state, facet.key);
  let values = [...counts.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (search.trim()) {
    const needle = search.trim().toLowerCase();
    values = values.filter((v) => v.toLowerCase().includes(needle));
  }

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="absolute left-0 top-full z-20 mt-1 w-60 rounded-md border border-line bg-surface p-2 shadow-lg"
    >
      <input
        type="text"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder={`Search ${facet.label}…`}
        className="mb-2 min-h-[28px] w-full rounded-md border border-line bg-surface px-2 py-1 text-[12px] text-ink-2"
      />
      <div className="mb-1.5 flex items-center justify-between border-b border-line-soft pb-1.5 text-[11px]">
        <button type="button" onClick={() => onSetAll(values)} className="text-accent hover:underline">
          Select all
        </button>
        <button type="button" onClick={onClear} className="text-accent hover:underline">
          Clear
        </button>
      </div>
      <div className="flex max-h-56 flex-col overflow-y-auto">
        {values.length === 0 ? (
          <div className="px-1 py-1.5 text-[12px] text-ink-3">No matching values</div>
        ) : (
          values.map((v) => {
            const c = counts.get(v) ?? 0;
            return (
              <label key={v} className={`flex items-center gap-2 rounded px-1 py-1 text-[12px] hover:bg-surface-2 ${c === 0 ? "opacity-40" : ""}`}>
                <input type="checkbox" checked={selected.has(v)} onChange={() => onToggle(v)} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate" title={v}>
                  {v}
                </span>
                <span className="font-mono text-[11px] text-ink-3">{c}</span>
              </label>
            );
          })
        )}
      </div>
    </div>
  );
}
