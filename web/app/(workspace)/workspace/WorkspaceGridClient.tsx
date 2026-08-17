"use client";

import { useRef, useState, useEffect, useMemo, useCallback, useTransition } from "react";
import { GridLayout, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { removeComponent, updateComponentLayout, resetWorkspace } from "@/lib/workspace/actions";
import { Button } from "@/components/ui/button";
import { Badge, type BadgeProps } from "@/components/ui/badge";

export type GridItemMeta = {
  id: string;
  componentName: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Phase 9 cost indicator, from workspace.component_definitions.cost. */
  cost: "low" | "medium" | "high";
};

const COST_BADGE_VARIANT: Record<GridItemMeta["cost"], BadgeProps["variant"]> = {
  low: "good",
  medium: "warn",
  high: "destructive",
};

/**
 * The only client-side piece of the Workspace Builder — react-grid-layout
 * needs a browser to handle drag/resize at all. Every child's actual
 * content (KPI grid, table, chart) was already rendered server-side in
 * page.tsx and is passed in as `children`; this component only positions
 * them and persists position changes. No workspace DATA crosses the
 * server/client boundary here, only layout geometry (x/y/w/h) and the
 * component instance ids react-grid-layout needs.
 */
export function WorkspaceGridClient({
  workspaceId,
  items,
  children,
  toolbarExtra,
}: {
  workspaceId: string;
  items: GridItemMeta[];
  children: React.ReactNode[];
  /**
   * 2026-08-15 consolidated-toolbar fix: AddComponentPicker (a client
   * component itself) rendered into the SAME row as Save layout/Reset
   * workspace below, instead of a separate row in page.tsx — those three
   * were previously in two disconnected locations, a real UX
   * inconsistency flagged directly by the user. Passed as a prop rather
   * than lifting Save/Reset's dirty/isPending state up into page.tsx
   * (a Server Component, which can't hold client state) — composition,
   * not a state hoist.
   */
  toolbarExtra?: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1160);
  // The layout GridLayout RENDERS FROM is always derived straight from the
  // server-sourced `items` prop — never fed back from onLayoutChange. RGL
  // fires onLayoutChange during its own internal mount/compaction pass
  // (notably right after the width prop corrects from its initial guess to
  // the real measured value), and feeding that straight back into the
  // controlling `layout` state created a loop that stomped the real
  // (DB-sourced) w/h with a degenerate 1x1 layout before the user ever
  // touched anything. pendingLayout is the ONLY thing onLayoutChange writes
  // to, and it's purely a save payload — display and "what we'll save" are
  // deliberately decoupled.
  const layout: Layout = useMemo(
    () => items.map((it) => ({ i: it.id, x: it.x, y: it.y, w: it.w, h: it.h })),
    [items]
  );
  const [pendingLayout, setPendingLayout] = useState<Layout | null>(null);
  const [dirty, setDirty] = useState(false);
  const [isPending, startTransition] = useTransition();

  // A fresh `items` prop (add/remove/reload) means the server truth moved
  // on — drop any unsaved drag/resize so the display goes back to being
  // purely server-derived rather than showing a stale pending position.
  useEffect(() => {
    setPendingLayout(null);
    setDirty(false);
  }, [items]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Only real user interaction (a drag or resize actually ending) marks the
  // layout dirty — see the layout/pendingLayout comment above for why
  // onLayoutChange itself isn't used for this.
  const handleInteractionStop = useCallback((next: Layout) => {
    setPendingLayout(next);
    setDirty(true);
  }, []);

  const handleSave = () => {
    const toSave = pendingLayout ?? layout;
    startTransition(async () => {
      await updateComponentLayout(toSave.map((l) => ({ id: l.i, x: l.x, y: l.y, w: l.w, h: l.h })));
      setDirty(false);
      setPendingLayout(null);
    });
  };

  const handleRemove = (id: string) => {
    startTransition(async () => {
      await removeComponent(id);
    });
  };

  const handleReset = () => {
    if (!confirm("Remove every component from this workspace? This can't be undone.")) return;
    startTransition(async () => {
      await resetWorkspace(workspaceId);
    });
  };

  const rowHeight = 60;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>{toolbarExtra}</div>
        {items.length > 0 && (
          <div className="flex items-center gap-2">
            {dirty && (
              <Button size="sm" onClick={handleSave} disabled={isPending}>
                {isPending ? "Saving…" : "Save layout"}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={handleReset} disabled={isPending}>
              Reset workspace
            </Button>
          </div>
        )}
      </div>

      <div ref={containerRef}>
        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-line-soft bg-surface-2 px-10 py-14 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-surface text-ink-3">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-6 w-6">
                <rect x="3" y="4" width="7" height="7" rx="1" />
                <rect x="14" y="4" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="6" rx="1" />
                <rect x="14" y="14" width="7" height="6" rx="1" />
              </svg>
            </span>
            <p className="text-sm font-medium text-ink-2">This workspace is empty</p>
            <p className="max-w-xs text-[12.5px] text-ink-3">
              Use &ldquo;Add component&rdquo; above to build a dashboard from Sales KPIs, trends and rankings —
              scoped to the store and date range you set.
            </p>
          </div>
        ) : (
          <GridLayout
            className="layout"
            layout={pendingLayout ?? layout}
            gridConfig={{ cols: 12, rowHeight, margin: [12, 12] }}
            width={width}
            onDragStop={handleInteractionStop}
            onResizeStop={handleInteractionStop}
            dragConfig={{ handle: ".workspace-card-handle" }}
          >
            {items.map((item, i) => (
              <div
                key={item.id}
                className="group flex flex-col overflow-hidden rounded-lg border border-line-soft bg-surface shadow-sm transition-shadow hover:shadow-md"
              >
                <div className="workspace-card-handle flex shrink-0 cursor-move items-center justify-between border-b border-line-soft bg-surface-2 px-3 py-1.5">
                  <span className="flex items-center gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">{item.componentName}</span>
                    <Badge variant={COST_BADGE_VARIANT[item.cost]} title={`${item.cost} query cost`}>
                      {item.cost}
                    </Badge>
                  </span>
                  <button
                    type="button"
                    onClick={() => handleRemove(item.id)}
                    disabled={isPending}
                    className="rounded p-0.5 text-ink-3 opacity-0 transition-opacity hover:bg-crit-soft hover:text-crit group-hover:opacity-100"
                    aria-label={`Remove ${item.componentName}`}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-auto p-3">{children[i]}</div>
              </div>
            ))}
          </GridLayout>
        )}
      </div>
    </div>
  );
}
