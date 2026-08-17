/**
 * Shape-matched loading placeholders for Suspense fallbacks. Deliberately
 * not a generic spinner — each skeleton mirrors the grid/table/chart it is
 * standing in for, per the "user should immediately understand what's
 * loading" requirement, and `RouteLoadingBar` (the route-level top bar) stays
 * as-is for full navigations; these are for streamed-in sections within a
 * page that has already rendered its shell.
 */
function Block({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={`animate-pulse rounded-sm bg-surface-2 ${className}`} style={style} />;
}

export function KpiGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="border-line-soft bg-surface px-4 pb-3 pt-3.5">
          <Block className="h-2.5 w-16" />
          <Block className="mt-2.5 h-6 w-20" />
          <Block className="mt-2 h-2.5 w-24" />
        </div>
      ))}
    </div>
  );
}

export function ChartSkeleton({ height = 180 }: { height?: number }) {
  return (
    <div className="mt-2 border border-line-soft p-3">
      <Block className="w-full" style={{ height }} />
    </div>
  );
}

export function TableSkeleton({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="mt-2 overflow-x-auto border border-line-soft">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line-soft bg-surface-2">
            {Array.from({ length: cols }).map((_, i) => (
              <th key={i} className="px-3 py-2">
                <Block className="h-2.5 w-14" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, r) => (
            <tr key={r} className="border-b border-line-soft last:border-0">
              {Array.from({ length: cols }).map((_, c) => (
                <td key={c} className="px-3 py-2.5">
                  <Block className="h-3 w-full max-w-[80px]" />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MatrixSkeleton() {
  return (
    <div className="mt-2 overflow-x-auto border border-line-soft">
      <div className="grid min-w-[560px] grid-cols-[90px_1fr_1fr] gap-px bg-line-soft">
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="bg-surface p-3">
            <Block className="h-16 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function SectionLabelSkeleton() {
  return <Block className="mt-6 h-2.5 w-32" />;
}
