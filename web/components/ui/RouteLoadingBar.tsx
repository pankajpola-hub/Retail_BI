/**
 * Fallback shown by each route group's loading.tsx while its next page's
 * server work is in flight (Next's built-in Suspense-boundary loading UI —
 * see https://nextjs.org/docs/app/api-reference/file-conventions/loading).
 *
 * Deliberately just the slim bar, nothing else: loading.tsx replaces
 * `children` inside the layout (the layout itself, including the sticky
 * TopNav, stays mounted and visible), so rendering a big centered spinner or
 * skeleton here would read as the page going blank. A plain server
 * component (no "use client") so it renders immediately, before any client
 * JS loads — the same visual as TopProgressBar, which handles the
 * click-triggered instant-feedback case; this one is the fallback for
 * slower navigations where Next's Suspense boundary actually engages.
 */
export function RouteLoadingBar() {
  return (
    <div aria-hidden className="fixed inset-x-0 top-0 z-[100] h-[2.5px] overflow-hidden">
      <div className="h-full w-1/3 animate-top-progress bg-accent" />
    </div>
  );
}
