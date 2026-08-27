"use client";

import { useTransition, useEffect } from "react";

/**
 * useTransition that also drives the global TopProgressBar.
 *
 * TopProgressBar only observes link clicks, form submits and select changes,
 * so a Server Action dispatched through startTransition — which touches none
 * of those and never changes the URL — produced no top-of-page cue at all
 * (audit finding: progress-bar Gap 2). The "progressbar:start"/"progressbar:stop"
 * CustomEvent pair is already TopProgressBar's public "I am doing something"
 * API (it listens for both), so nothing there needs changing; call sites just
 * swap useTransition() for this.
 */
export function useProgressTransition() {
  const [isPending, startTransition] = useTransition();
  useEffect(() => {
    window.dispatchEvent(new CustomEvent(isPending ? "progressbar:start" : "progressbar:stop"));
  }, [isPending]);
  return [isPending, startTransition] as const;
}
