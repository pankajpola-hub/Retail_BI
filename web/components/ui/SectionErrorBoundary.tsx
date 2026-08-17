"use client";

import { Component, type ReactNode } from "react";
import { useRouter } from "next/navigation";

/**
 * Scopes a failing streamed section to itself instead of taking down the
 * whole page — Next.js's route-level error.tsx only gives one boundary per
 * route segment, which would replace EVERYTHING (including sections that
 * loaded fine) if a single Suspense-streamed section throws. A client-side
 * React error boundary placed around each individual Suspense block is the
 * documented way to get per-section granularity instead.
 *
 * Class component because React error boundaries require the
 * componentDidCatch/getDerivedStateFromError lifecycle — there is no hook
 * equivalent. Retry calls router.refresh() (re-renders Server Components in
 * place) rather than resetting local state alone, which would just redisplay
 * the same already-failed RSC payload without ever re-running the query.
 */
type Props = { label: string; children: ReactNode; onRetry: () => void };
type State = { hasError: boolean };

class ErrorBoundaryInner extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    // eslint-disable-next-line no-console
    console.error(`[${this.props.label}] section failed to render:`, error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="mt-6 border-l-2 border-crit bg-crit-soft px-4 py-3 text-sm text-ink-2">
          <p className="font-semibold text-crit">Unable to load {this.props.label}.</p>
          <p className="mt-1 text-ink-3">The rest of this page is unaffected — try reloading.</p>
          <button
            type="button"
            onClick={() => {
              this.setState({ hasError: false });
              this.props.onRetry();
            }}
            className="mt-2 border border-line px-3 py-1 text-[12px] text-ink-2 hover:bg-surface-2"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function SectionErrorBoundary({ label, children }: { label: string; children: ReactNode }) {
  const router = useRouter();
  return (
    <ErrorBoundaryInner label={label} onRetry={() => router.refresh()}>
      {children}
    </ErrorBoundaryInner>
  );
}
