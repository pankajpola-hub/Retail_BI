"use client";

import { useEffect, useRef, useState } from "react";
import { useProgressTransition } from "@/components/ui/useProgressTransition";
import { addComponent } from "@/lib/workspace/actions";
import { Button } from "@/components/ui/button";

export type PickableComponent = {
  id: string;
  name: string;
  description: string;
  defaultW: number;
  defaultH: number;
  category: string;
};

// One small glyph per component, purely decorative — gives the flyout the
// same "recognizable visual, not just a text list" feel as Power BI's
// Insert Visual gallery / Sigma's element picker, without pulling in an
// icon library for six icons.
const ICONS: Record<string, JSX.Element> = {
  sales_kpi_grid: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="4" width="7" height="7" rx="1"/><rect x="14" y="4" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="6" rx="1"/><rect x="14" y="14" width="7" height="6" rx="1"/></svg>
  ),
  weekly_sales_table: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 9h18M3 14h18M9 4v16"/></svg>
  ),
  sales_trend_chart: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 17l5-6 4 3 8-9"/><path d="M3 20h18"/></svg>
  ),
  hourly_sales_chart: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 20V10M10 20V4M16 20v-7"/><path d="M2 20h20"/></svg>
  ),
  store_league_table: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M8 21h8M12 17v4M5 4h14l-1.5 8.5a5 5 0 0 1-11 0L5 4Z"/></svg>
  ),
  scheme_penetration: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 6.9 12l-6.9-4V4Z" fill="currentColor" stroke="none" opacity=".18"/></svg>
  ),
  agent_sales_table: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="9" cy="7" r="3"/><path d="M2 21c0-3.3 3.1-6 7-6s7 2.7 7 6"/><path d="M16 4.5a3 3 0 0 1 0 5.9M21 21c0-2.7-1.9-5-4.5-5.7"/></svg>
  ),
  // 2026-08-15 — first non-Sales components (Stock, Mix).
  gender_split_card: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="8" cy="8" r="4"/><path d="M16 4l2 2-2 2M18 6h-6"/><path d="M2 21c0-3.3 2.7-6 6-6s6 2.7 6 6"/></svg>
  ),
  stock_vs_capacity_table: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 9h18M3 14h18M9 4v16"/><path d="M13 17l2 2 3-4" strokeWidth="1.8"/></svg>
  ),
  stock_breakdown_table: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 20V10M10 20V4M16 20v-7"/><path d="M2 20h20"/></svg>
  ),
  capacity_editor: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
  ),
  sale_stock_mix_table: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 4h6l-4 8H2l4-8Z"/><path d="M14 4h6l-4 8h-6l4-8Z"/><path d="M9 20h9"/></svg>
  ),
  // 2026-08-20 — third non-Sales family (Replenishment) + a second Mix component.
  replenishment_kpi_grid: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M21 8V5a1 1 0 0 0-1-1h-3M3 8V5a1 1 0 0 1 1-1h3M21 16v3a1 1 0 0 1-1 1h-3M3 16v3a1 1 0 0 0 1 1h3"/><path d="M9 12h6M12 9v6"/></svg>
  ),
  top_supply_moves_table: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 12h6l3-8 3 16 3-8h3"/></svg>
  ),
  replenishment_recommendations_table: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 9h18M8 9v11"/><circle cx="5.5" cy="6.5" r=".8" fill="currentColor" stroke="none"/></svg>
  ),
  mix_status_kpi_grid: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="8"/><path d="M12 4v8l6 3"/></svg>
  ),
  // 2026-08-20 — footfall family (7 components).
  footfall_kpi_grid: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 3a3 3 0 0 1 3 3c0 2-3 3-3 5"/><circle cx="12" cy="15" r="1"/><path d="M6 21c0-3 2.5-5 6-5s6 2 6 5"/></svg>
  ),
  footfall_quality_kpi_grid: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>
  ),
  network_insights_kpi_grid: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 7v6M12 13l-6 4M12 13l6 4"/></svg>
  ),
  suggested_actions: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 2a5 5 0 0 1 3 9c-.6.5-1 1.3-1 2v1H10v-1c0-.7-.4-1.5-1-2a5 5 0 0 1 3-9Z"/><path d="M10 19h4M11 22h2"/></svg>
  ),
  footfall_conversion_matrix: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg>
  ),
  traffic_sales_matrix: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1" fill="currentColor" opacity=".18"/></svg>
  ),
  store_diagnosis_table: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 9h18M8 9v11"/></svg>
  ),
  // 2026-08-20 — targets family.
  fresh_discounted_tracker: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 9h18"/><rect x="6" y="12" width="4" height="4" fill="currentColor" stroke="none" opacity=".3"/><rect x="14" y="12" width="4" height="4" fill="currentColor" stroke="none" opacity=".6"/></svg>
  ),
  upload_history_list: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 3v12m0-12 4 4m-4-4-4 4"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/></svg>
  ),
};

const CATEGORY_LABELS: Record<string, string> = {
  sales: "Sales",
  stock: "Stock",
  mix: "Sale vs Stock Mix",
  replenishment: "Replenishment",
  footfall: "Footfall & Growth",
  targets: "Targets",
};

export function AddComponentPicker({
  workspaceId,
  available,
  nextY,
}: {
  workspaceId: string;
  available: PickableComponent[];
  nextY: number;
}) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useProgressTransition();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  if (available.length === 0) return null;

  function handlePick(comp: PickableComponent) {
    setOpen(false);
    startTransition(async () => {
      await addComponent(workspaceId, comp.id, { x: 0, y: nextY, w: comp.defaultW, h: comp.defaultH });
    });
  }

  return (
    <div ref={containerRef} className="relative">
      <Button
        onClick={() => setOpen((v) => !v)}
        disabled={isPending}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <span className="text-base leading-none">+</span> Add component
      </Button>

      {open && (
        <div className="absolute left-0 top-full z-20 mt-2 max-h-[70vh] w-[360px] overflow-y-auto rounded-lg border border-line bg-surface p-2 shadow-xl">
          {Object.entries(
            available.reduce<Record<string, PickableComponent[]>>((acc, comp) => {
              (acc[comp.category] ??= []).push(comp);
              return acc;
            }, {})
          ).map(([category, comps]) => (
            <div key={category} className="mb-2 last:mb-0">
              <div className="px-2 pb-2 pt-1 text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
                {CATEGORY_LABELS[category] ?? category}
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {comps.map((comp) => (
                  <button
                    key={comp.id}
                    type="button"
                    onClick={() => handlePick(comp)}
                    className="flex flex-col items-start gap-1.5 rounded-md border border-line-soft p-2.5 text-left hover:border-accent hover:bg-accent-soft"
                  >
                    <span className="flex h-7 w-7 items-center justify-center rounded bg-surface-2 text-ink-2">
                      <span className="h-4 w-4">{ICONS[comp.id]}</span>
                    </span>
                    <span className="text-[12.5px] font-semibold leading-tight text-ink">{comp.name}</span>
                    <span className="text-[11px] leading-snug text-ink-3">{comp.description}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
