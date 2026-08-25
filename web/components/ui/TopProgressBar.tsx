"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * Slim, fixed top-of-viewport progress bar shown while a navigation or form
 * submission is in flight — the "processing bar" from the user's feedback.
 * Deliberately NOT next/font-loading-indicator or a full-page spinner: it's
 * a 2px bar above everything else (including the sticky TopNav), and it
 * never blocks or replaces page content.
 *
 * How it detects "something is happening" (Next 14 App Router has no public
 * router-events API to hook into directly):
 *  - Link clicks: a capturing click listener on `document` starts the bar
 *    the instant an internal <a> is clicked.
 *  - Form submits: likewise for Server Action forms (e.g. login, invite
 *    user, process upload) that don't necessarily change the URL.
 *  - <select> changes: StoreFilter/AttributeFilter drive their navigation
 *    off a native <select onChange>, which isn't a click on an <a> or a form
 *    submit, so it needs its own listener.
 *  - A "progressbar:start" CustomEvent on `window`: MultiSelectFilter's
 *    checkbox popover commits via a plain <button> click deep inside a
 *    portal-less dropdown, not a link/form/select — it dispatches this event
 *    itself right before calling router.push (see StoreFilter.tsx).
 *  - Completion: `usePathname`/`useSearchParams` changing means the new
 *    route has actually rendered, so the bar hides. A safety-net timeout
 *    also hides it after 20s in case a submit never changes the URL (e.g. a
 *    Server Action that only revalidates data in place) so it can never get
 *    stuck showing forever.
 *  - A "progressbar:stop" CustomEvent on `window` — for a multi-step
 *    client-side flow that never changes the URL at all (2026-08-25:
 *    ProcessButton's preview -> commit sequence on the Data Upload page
 *    calls router.refresh(), which re-fetches server data in place without
 *    touching pathname/searchParams), the route-change completion signal
 *    never fires. Such a flow dispatches "progressbar:start" itself right
 *    before its fetch and "progressbar:stop" right after, rather than
 *    relying on the 20s fallback timer (correct, but far too slow to be
 *    the normal path for an operation that usually takes 1-2s).
 *
 * Only actually becomes visible if 500ms pass without the matching
 * completion — fast interactions (most of them) never flash it at all.
 */
const SHOW_DELAY_MS = 500;

function TopProgressBarInner() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [active, setActive] = useState(false);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedAt = useRef<number>(0);

  function stop() {
    setActive(false);
    if (showTimer.current) {
      clearTimeout(showTimer.current);
      showTimer.current = null;
    }
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }

  // Route actually changed -> the navigation this bar was showing for is
  // done. Skip the very first run (mount), which isn't a completion.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, searchParams]);

  useEffect(() => {
    function start() {
      startedAt.current = Date.now();
      if (showTimer.current || hideTimer.current) return; // already pending/active
      showTimer.current = setTimeout(() => {
        setActive(true);
        showTimer.current = null;
      }, SHOW_DELAY_MS);
      // 20s not 6s — the real completion signal (pathname/searchParams
      // changing) already hides the bar the instant a navigation actually
      // finishes, however fast that is; this is purely a fallback for a
      // navigation that never resolves. A short fallback was actively
      // misleading on slow pages (Stock Details' unfiltered fetch could
      // take longer than 6s): the bar would disappear before the real fetch
      // landed, leaving stale content on screen with no loading cue at all.
      hideTimer.current = setTimeout(stop, 20000);
    }

    function onSelectChange(e: Event) {
      if ((e.target as HTMLElement | null)?.tagName === "SELECT") start();
    }

    function onCustomStart() {
      start();
    }

    function onCustomStop() {
      stop();
    }

    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as HTMLElement | null)?.closest?.("a");
      if (!anchor) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
      let url: URL;
      try {
        url = new URL(href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      start();
    }

    function onSubmit(e: SubmitEvent) {
      const form = e.target as HTMLFormElement | null;
      if (form?.tagName === "FORM") start();
    }

    // Capturing phase so this fires even if a handler further down calls
    // stopPropagation (e.g. a form's own onSubmit).
    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit, true);
    document.addEventListener("change", onSelectChange, true);
    window.addEventListener("progressbar:start", onCustomStart);
    window.addEventListener("progressbar:stop", onCustomStop);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit, true);
      document.removeEventListener("change", onSelectChange, true);
      window.removeEventListener("progressbar:start", onCustomStart);
      window.removeEventListener("progressbar:stop", onCustomStop);
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      aria-hidden
      className={`pointer-events-none fixed inset-x-0 top-0 z-[100] h-[2.5px] overflow-hidden transition-opacity duration-150 ${
        active ? "opacity-100" : "opacity-0"
      }`}
    >
      <div className={`h-full w-1/3 bg-accent ${active ? "animate-top-progress" : ""}`} />
    </div>
  );
}

export function TopProgressBar() {
  // useSearchParams requires a Suspense boundary in the App Router, else the
  // page it's used on gets de-opted into fully client-side rendering.
  return (
    <Suspense fallback={null}>
      <TopProgressBarInner />
    </Suspense>
  );
}
