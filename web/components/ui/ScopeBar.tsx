import type { VerticalScope } from "@/lib/scope/resolveViewScope";
import { MultiSelectFilter } from "./StoreFilter";
import { DateRangePicker } from "./DateRangePicker";
import { ComparisonDateRangePicker } from "./ComparisonDateRangePicker";

/**
 * Visual grouping of three existing, already-working filter patterns into
 * one bordered bar — Vertical / Location / Period — per the BI UI/UX
 * proposal's scope-bar spec. Deliberately NOT a new interaction model:
 * Location and Period are the same MultiSelectFilter/DateRangePicker
 * components every page already uses, just repositioned; Vertical is the
 * same MultiSelectFilter pattern applied to a new `bu` search param.
 *
 * A vertical that's `granted && !pipelineConnected` (MBO/LFS today) is never
 * passed into the filter as a selectable option — it renders as a separate
 * static disabled chip with a status tooltip instead, so "no pipeline yet"
 * reads as a project-status fact, not a permission wall a user might expect
 * to unlock. A vertical the user isn't `granted` at all is simply absent
 * from both — not rendered anywhere in this bar.
 */
export function ScopeBar({
  verticals,
  selectedVerticals,
  locationSlot,
  from,
  to,
  compareFrom = null,
  compareTo = null,
  showComparison = false,
}: {
  verticals: VerticalScope[];
  selectedVerticals: string[];
  locationSlot: React.ReactNode;
  from: string;
  to: string;
  /**
   * Period comparison (Phase 4, 2026-08-26). Off unless `showComparison` is
   * passed, so any page that mounts this bar without opting in renders
   * exactly the bar it rendered before. Comparison is only *active* when
   * both compareFrom and compareTo are set — see the picker's own header.
   */
  compareFrom?: string | null;
  compareTo?: string | null;
  showComparison?: boolean;
}) {
  const selectable = verticals.filter((v) => v.granted && v.pipelineConnected);
  const pending = verticals.filter((v) => v.granted && !v.pipelineConnected);

  return (
    <div className="flex flex-wrap items-end gap-7 rounded-lg border border-line-soft bg-surface px-4 py-3 shadow-sm">
      <div>
        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">Vertical</div>
        <div className="flex flex-wrap items-center gap-1.5">
          {selectable.length > 1 && (
            <MultiSelectFilter
              paramName="bu"
              options={selectable.map((v) => v.key)}
              labels={Object.fromEntries(selectable.map((v) => [v.key, v.label]))}
              selected={selectedVerticals}
              allLabel="All"
            />
          )}
          {selectable.length === 1 && (
            <span className="rounded-full bg-accent-soft px-3 py-1 text-[12.5px] font-semibold text-accent-ink">
              {selectable[0]!.label}
            </span>
          )}
          {pending.map((v) => (
            <span
              key={v.key}
              title={`${v.label} data pipeline not yet connected`}
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-line px-2.5 py-1 text-[12px] font-medium text-ink-3"
            >
              {v.label}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-3 w-3">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 10.5v6M12 7.5h.01" />
              </svg>
            </span>
          ))}
        </div>
      </div>

      {locationSlot && (
        <>
          <div className="hidden self-stretch border-l border-line-soft sm:block" />
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">Location</div>
            {locationSlot}
          </div>
        </>
      )}

      <div className="hidden self-stretch border-l border-line-soft sm:block" />
      <div>
        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">Period</div>
        <div className="flex flex-wrap items-center gap-2">
          <DateRangePicker from={from} to={to} />
          {showComparison && <ComparisonDateRangePicker from={from} to={to} compareFrom={compareFrom} compareTo={compareTo} />}
        </div>
      </div>
    </div>
  );
}
