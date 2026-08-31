import { Suspense } from "react";
import { createClient, fetchAllRows } from "@/lib/data/client";
import type { QueryChain } from "@/lib/data/client";
import { requirePageAccess } from "@/lib/auth/roles";
import { KpiGridSkeleton, ChartSkeleton, TableSkeleton, SectionLabelSkeleton } from "@/components/ui/Skeleton";
import { SectionErrorBoundary } from "@/components/ui/SectionErrorBoundary";
import { MonthRangePicker } from "./MonthRangePicker";
import { ComparisonMonthRangePicker } from "./ComparisonMonthRangePicker";
import { SaleSummaryClient } from "./SaleSummaryClient";
import { SaleSummaryShell } from "./SaleSummaryShell";
import type { ChannelSalesRow } from "@/lib/saleSummary/aggregate";
import { currentYm, shiftMonth, monthToFirstOfMonthDate, monthToExclusiveUpperBound } from "@/lib/saleSummary/month";

export const dynamic = "force-dynamic";

/**
 * Sale Summary — wholesale/distribution-channel sales (agents, distributors,
 * LFS, MBO, ecommerce marketplaces), migration 0101. A completely different
 * business view from every other (ho) page (/sales, /targets,
 * /stock-details, /movement), which are all EBO-retail-focused; this one
 * reads a monthly PRE-AGGREGATED upload (one row per branch × month × party
 * × channel) rather than bill/line-grain transactions.
 *
 * Gate: requirePageAccess("sale-summary") — ho_admin / regional_manager /
 * super_admin (see migration 0101's core.role_permissions seed and
 * lib/auth/roles.ts's PAGE_ROLE_DEFAULTS["sale-summary"] for the reasoning:
 * wholesale/distribution financials, not store-scoped, more sensitive than
 * the retail EBO numbers already on /sales).
 *
 * ONE streamed section: unlike /sales (which independently streams 5
 * sections because it issues 5+ genuinely separate queries across two
 * different verticals), this page has exactly one dataset — every KPI,
 * table and the trend chart are all derived, client-side, from the same
 * sales.vw_channel_sales_summary row set (see SaleSummaryClient.tsx for
 * why: the page-level FacetFilterBar must drive the KPI cards too, and
 * FacetFilterState only exists in a client component). Still wrapped in its
 * own Suspense + SectionErrorBoundary rather than a blocking top-level
 * await, matching this app's established "don't ship a single blocking
 * fetch for the whole page" convention — a real second section would slot
 * in the same way if one is ever needed.
 */
async function ChannelSalesSection({
  fromMonth,
  toMonth,
  compareFromMonth,
  compareToMonth,
}: {
  fromMonth: string;
  toMonth: string;
  compareFromMonth: string | null;
  compareToMonth: string | null;
}) {
  const supabase = await createClient();
  const from = monthToFirstOfMonthDate(fromMonth);
  const toExclusive = monthToExclusiveUpperBound(toMonth);
  const comparing = Boolean(compareFromMonth && compareToMonth);

  // fetchAllRows(): PostgREST's project-level "Max Rows" caps every response
  // at 1000 regardless of .limit() (see lib/data/client.ts's own note, and
  // the sales page's identical reasoning) — a wide month range on this
  // table (8,146 rows in the profiled 22-month sample, i.e. already close
  // to that cap for the full history) would otherwise silently truncate.
  // .order() is required, not decoration: .range()-paginated calls are only
  // a correct partition of the table if the server-side ordering is stable
  // across the separate REST calls.
  const selectCols = "id, branch_name, bill_month, party_name, channel_name, channel_type, channel_model, total_quantity, gross_amount, net_amount";

  const rowsPromise = fetchAllRows<ChannelSalesRow>(
    () =>
      supabase
        .schema("sales")
        .from<ChannelSalesRow>("vw_channel_sales_summary")
        .select(selectCols)
        .gte("bill_month", from)
        .lt("bill_month", toExclusive)
        .order("bill_month", { ascending: true })
        .order("id", { ascending: true }) as unknown as QueryChain<ChannelSalesRow>
  );

  // Comparison row set, driven by the user-chosen compareFromMonth/
  // compareToMonth (ComparisonMonthRangePicker.tsx) — replaces the old fixed
  // "12 months before fromMonth" lookback now that comparison is an
  // arbitrary range, not a single latest-month-vs-baseline read. Only
  // fetched at all when comparison is ON (both params present): per Pankaj,
  // "'Comparison settings' should be optional only if user wants to use
  // only" — an unopened comparison picker must cost nothing extra. A
  // SEPARATE query/array from `rows`, not a wider single fetch —
  // FacetFilterBar's facet option-counts must stay anchored to the page's
  // own displayed month range (`rows`), not quietly widen to include the
  // comparison range the user picked.
  const compareRowsPromise: Promise<ChannelSalesRow[]> = comparing
    ? fetchAllRows<ChannelSalesRow>(
        () =>
          supabase
            .schema("sales")
            .from<ChannelSalesRow>("vw_channel_sales_summary")
            .select(selectCols)
            .gte("bill_month", monthToFirstOfMonthDate(compareFromMonth as string))
            .lt("bill_month", monthToExclusiveUpperBound(compareToMonth as string))
            .order("bill_month", { ascending: true })
            .order("id", { ascending: true }) as unknown as QueryChain<ChannelSalesRow>
      )
    : Promise.resolve([]);

  const [rows, compareRows] = await Promise.all([rowsPromise, compareRowsPromise]);

  return (
    <SaleSummaryClient
      rows={rows}
      compareRows={compareRows}
      fromMonth={fromMonth}
      toMonth={toMonth}
      compareFromMonth={compareFromMonth}
      compareToMonth={compareToMonth}
    />
  );
}

function ChannelSalesSkeleton() {
  return (
    <>
      <KpiGridSkeleton count={6} />
      <div className="mt-6">
        <SectionLabelSkeleton />
        <TableSkeleton rows={6} cols={5} />
      </div>
      <div className="mt-6">
        <SectionLabelSkeleton />
        <TableSkeleton rows={5} cols={5} />
      </div>
      <div className="mt-6">
        <SectionLabelSkeleton />
        <TableSkeleton rows={8} cols={5} />
      </div>
      <div className="mt-6">
        <SectionLabelSkeleton />
        <ChartSkeleton height={220} />
      </div>
    </>
  );
}

export default async function SaleSummaryPage({
  searchParams,
}: {
  searchParams: { fromMonth?: string; toMonth?: string; compareFromMonth?: string; compareToMonth?: string };
}) {
  await requirePageAccess("sale-summary");

  const now = currentYm();
  // Default range: last 12 months touching today, same "reasonable default,
  // not the dawn of time" convention DateRangePicker's own presets use.
  const toMonth = searchParams.toMonth ?? now;
  const fromMonth = searchParams.fromMonth ?? shiftMonth(toMonth, -11);

  // Comparison is "on" exactly when BOTH params are present in the URL —
  // no separate flag (per Pankaj: comparison must be optional/opt-in). See
  // ComparisonMonthRangePicker.tsx.
  const compareFromMonth = searchParams.compareFromMonth && searchParams.compareToMonth ? searchParams.compareFromMonth : null;
  const compareToMonth = searchParams.compareFromMonth && searchParams.compareToMonth ? searchParams.compareToMonth : null;

  return (
    <main className="py-6">
      <div>
        <h1 className="font-serif text-2xl">Sale Summary</h1>
        <p className="mt-1 max-w-2xl text-[12.5px] text-ink-3">
          Wholesale / distribution-channel sales — agents, distributors, LFS (Shoppers Stop, Lifestyle), MBO, and
          ecommerce marketplaces. Sourced from a monthly pre-aggregated upload, not day-level bills — see{" "}
          <a href="/data-upload" className="underline">
            Data Upload
          </a>{" "}
          to add a month.
        </p>
      </div>

      {
        // Frozen date filter (2026-08-31, per Pankaj: "freeze the date filter
        // at the top so scrolled data can be referable"). AppShell's own
        // fixed top bar is h-14 (56px, top-0, z-50 — components/ui/
        // AppShell.tsx) and the page content already sits below it
        // (pt-14 on the shell's content wrapper), so this bar's own sticky
        // `top` is set to that same 56px rather than 0 — otherwise it would
        // sit UNDER the app's own top bar while scrolled. z-30 keeps it
        // above table content but below AppShell's top bar (z-50) and
        // TopProgressBar (z-100).
      }
      {
        // SaleSummaryShell wraps from here down — it's the STABLE ancestor
        // (a Client Component holding facet/comparison/returns-only state in
        // Context) that sits ABOVE the <Suspense> boundary below, so that
        // state survives a fromMonth/toMonth navigation even though
        // ChannelSalesSection/SaleSummaryClient underneath it remounts. See
        // SaleSummaryShell.tsx's header for the full root-cause writeup.
      }
      <SaleSummaryShell>
        <div className="sticky top-14 z-30 -mx-4 mt-4 border-b border-line-soft bg-ground/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-ground/80 sm:-mx-6 sm:px-6">
          {
            // Main + comparison pickers side by side (ask 3: "shift this on
            // header where main date filter freezed") — wraps to a stacked
            // layout on narrow screens via flex-wrap, same responsive
            // convention as this app's other filter bars.
          }
          <div className="flex flex-wrap items-center gap-2">
            <MonthRangePicker fromMonth={fromMonth} toMonth={toMonth} />
            <ComparisonMonthRangePicker
              fromMonth={fromMonth}
              toMonth={toMonth}
              compareFromMonth={compareFromMonth}
              compareToMonth={compareToMonth}
            />
          </div>
        </div>

        <div className="mt-6">
          <SectionErrorBoundary label="Sale Summary">
            <Suspense fallback={<ChannelSalesSkeleton />}>
              <ChannelSalesSection
                fromMonth={fromMonth}
                toMonth={toMonth}
                compareFromMonth={compareFromMonth}
                compareToMonth={compareToMonth}
              />
            </Suspense>
          </SectionErrorBoundary>
        </div>
      </SaleSummaryShell>
    </main>
  );
}
