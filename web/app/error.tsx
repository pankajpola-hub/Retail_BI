"use client";

import { useEffect } from "react";

/**
 * Route-level error boundary (D-06). Before this, an uncaught throw in any
 * Server Component — e.g. renderSalesComponents.tsx's deliberate throws when
 * a governed filter can't be applied, or a failed Postgres query in
 * workspace/page.tsx's Promise.all — fell through to Next's default error
 * page: a full white screen with no nav and no way back.
 *
 * This sits BELOW the four existing <SectionErrorBoundary> call sites, not
 * instead of them: those scope a single streamed section so the rest of the
 * page survives, and they still catch first. This is the net for everything
 * outside one — including every page that uses none.
 *
 * It renders inside the root layout, so the AppShell (top bar, nav) stays.
 * Visual treatment matches SectionErrorBoundary deliberately.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error("[route] page failed to render:", error);
  }, [error]);

  return (
    <main className="py-6">
      <div className="border-l-2 border-crit bg-crit-soft px-4 py-3 text-sm text-ink-2">
        <p className="font-semibold text-crit">Something went wrong loading this page.</p>
        <p className="mt-1 text-ink-3">
          The data behind it couldn&apos;t be fetched. Try again — if it keeps failing, the
          underlying report may still be loading, or your session may have expired.
        </p>
        {error.digest ? (
          <p className="mt-1 font-mono text-[11px] text-ink-3">Reference: {error.digest}</p>
        ) : null}
        <button
          type="button"
          onClick={reset}
          className="mt-2 border border-line px-3 py-1 text-[12px] text-ink-2 hover:bg-surface-2"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
