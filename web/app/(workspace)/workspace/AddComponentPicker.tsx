"use client";

import { useEffect, useRef, useState, useTransition } from "react";
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
  // 2026-08-15 — first non-Sales components (Stock, Mix).
  gender_split_card: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="8" cy="8" r="4"/><path d="M16 4l2 2-2 2M18 6h-6"/><path d="M2 21c0-3.3 2.7-6 6-6s6 2.7 6 6"/></svg>
  ),
  sale_stock_mix_table: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 4h6l-4 8H2l4-8Z"/><path d="M14 4h6l-4 8h-6l4-8Z"/><path d="M9 20h9"/></svg>
  ),
};

const CATEGORY_LABELS: Record<string, string> = {
  sales: "Sales",
  stock: "Stock",
  mix: "Sale vs Stock Mix",
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
  const [isPending, startTransition] = useTransition();
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
