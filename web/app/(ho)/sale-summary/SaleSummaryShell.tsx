"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { emptyFilterState, type FacetFilterState } from "@/components/ui/FacetFilterBar";

/**
 * Holds every piece of UI-only state that must survive a date-range change
 * (2026-08-31, per Pankaj: "date filter and Comparison settings and rest all
 * tables and charts are not synced").
 *
 * ROOT CAUSE this fixes: MonthRangePicker.apply() calls router.push() with a
 * new fromMonth/toMonth querystring. That's a genuinely new URL, so
 * page.tsx's <Suspense><ChannelSalesSection/></Suspense> re-suspends while
 * the server refetches — and when a Suspense boundary shows its fallback
 * again, React does NOT preserve the state of what it was previously
 * showing; SaleSummaryClient (the component INSIDE that Suspense boundary)
 * gets a fresh mount once the new data arrives. Every plain useState() that
 * used to live in SaleSummaryClient — facet/search state, the Returns-only
 * toggle, and the like-to-like toggle — was silently reset to its default on
 * every date-range change, which is exactly the "not synced" symptom: change
 * the date, and everything else quietly reverts without any visible signal
 * that it happened.
 *
 * THE FIX: move that state into a Context Provider rendered in page.tsx
 * ABOVE the <Suspense> boundary (SaleSummaryShell wraps
 * {children} = <Suspense>...), so it's a STABLE ancestor that never remounts
 * on a fromMonth/toMonth change — only ChannelSalesSection/SaleSummaryClient
 * underneath it does. SaleSummaryClient now reads this state via
 * useSaleSummaryState() instead of owning it, so its own remounts are
 * harmless: the values themselves live one level up and are simply re-read.
 *
 * A Server Component (page.tsx, ChannelSalesSection) can render a Client
 * Component's `children` prop with further Server Components inside it —
 * this is the standard Next.js "Client Component wrapping Server Component
 * children" pattern; the Provider here does not need to import or know
 * anything about ChannelSalesSection's server-side data fetching.
 *
 * comparisonType (the old MoM/YoY toggle) is GONE from this Context
 * (2026-08-31 redesign #2) — comparison is now an arbitrary range picked via
 * ComparisonMonthRangePicker, and that range (compareFromMonth/
 * compareToMonth) lives in the URL, not here. It doesn't need a Context slot
 * at all: URL params naturally survive the same Suspense remount this
 * Context exists to work around, since they're the very thing that DRIVES
 * the remount/refetch — duplicating them into Context would just be two
 * sources of truth for the same value. likeToLike stays here: it's a
 * client-only display preference that never changes what's fetched.
 */
export type SaleSummaryState = {
  filterState: FacetFilterState;
  setFilterState: (s: FacetFilterState) => void;
  returnsOnly: boolean;
  setReturnsOnly: (v: boolean) => void;
  likeToLike: boolean;
  setLikeToLike: (v: boolean) => void;
};

const SaleSummaryStateContext = createContext<SaleSummaryState | null>(null);

export function useSaleSummaryState(): SaleSummaryState {
  const ctx = useContext(SaleSummaryStateContext);
  if (!ctx) throw new Error("useSaleSummaryState() must be used within <SaleSummaryShell>.");
  return ctx;
}

export function SaleSummaryShell({ children }: { children: ReactNode }) {
  const [filterState, setFilterState] = useState<FacetFilterState>(emptyFilterState);
  const [returnsOnly, setReturnsOnly] = useState(false);
  // Default OFF — a simple total-vs-total comparison unless the user
  // explicitly opts into excluding newly-onboarded/churned channels.
  const [likeToLike, setLikeToLike] = useState(false);

  return (
    <SaleSummaryStateContext.Provider value={{ filterState, setFilterState, returnsOnly, setReturnsOnly, likeToLike, setLikeToLike }}>
      {children}
    </SaleSummaryStateContext.Provider>
  );
}
