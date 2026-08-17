"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Phase 9 — performance-aware workspaces, render-level viewport deferral.
 * Wraps one workspace card's already-rendered content (server-rendered JSX,
 * passed as `children` the same way WorkspaceGridClient receives it) and
 * withholds MOUNTING it until the card is within `rootMargin` of the
 * viewport. Once mounted it stays mounted — this is "don't pay for what's
 * off-screen right now", not virtualization that unmounts on scroll-away.
 *
 * SCOPE, stated plainly: this defers DOM mount (layout/paint cost — real
 * and significant for a 25-component workspace full of tables/charts), not
 * the underlying data QUERY. All added components' data is still fetched in
 * one shared server-side Promise.all (renderSalesComponents.tsx's
 * fetchSalesComponentData) regardless of scroll position — deferring the
 * fetch itself would need per-component streaming, the same shape as the
 * Phase 8 drilldown pattern, applied to initial load. That's a real
 * follow-up, not done here.
 */
export function LazyMount({ children, fallback }: { children: React.ReactNode; fallback: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (visible) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }

    // Synchronous fallback in addition to the observer below, not instead of
    // it: a card already on screen at mount time (the common case — most of
    // a workspace's first ~2 rows are above the fold) should never show a
    // skeleton flash while waiting for the observer's first callback tick.
    // Also makes this robust in environments where IntersectionObserver
    // requires an active compositor pass to fire at all (confirmed during
    // this feature's own verification — a headless/non-focused preview pane
    // never invoked ANY IntersectionObserver callback, even a bare one, even
    // though getBoundingClientRect showed the element correctly on screen).
    const rect = el.getBoundingClientRect();
    const margin = 200;
    const inViewNow =
      rect.bottom >= -margin &&
      rect.right >= -margin &&
      rect.top <= (window.innerHeight || document.documentElement.clientHeight) + margin &&
      rect.left <= (window.innerWidth || document.documentElement.clientWidth) + margin;
    if (inViewNow) {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) setVisible(true);
      },
      { rootMargin: "200px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  return <div ref={ref}>{visible ? children : fallback}</div>;
}
