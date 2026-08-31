import { Suspense } from "react";
import { createClient, fetchAllRows } from "@/lib/data/client";
import type { QueryChain } from "@/lib/data/client";
import { requirePageAccess } from "@/lib/auth/roles";
import { KpiGridSkeleton, ChartSkeleton, TableSkeleton, SectionLabelSkeleton } from "@/components/ui/Skeleton";
import { SectionErrorBoundary } from "@/components/ui/SectionErrorBoundary";
import { MonthRangePicker } from "./MonthRangePicker";
import { SaleSummaryClient } from "./SaleSummaryClient";
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
async function ChannelSalesSection({ fromMonth, toMonth }: { fromMonth: string; toMonth: string }) {
  const supabase = await createClient();
  const from = monthToFirstOfMonthDate(fromMonth);
  const toExclusive = monthToExclusiveUpperBound(toMonth);

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

  // Lookback window for the MoM/YoY comparison system (lib/saleSummary/
  // comparison.ts) — the comparison month for a given "latest month in
  // scope" can fall BEFORE `from` (e.g. YoY on a 3-month selection needs
  // data 12 months back, and MoM on a single-month selection needs the one
  // month right before it). Bounded to a fixed 12 months before `fromMonth`
  // regardless of how wide [fromMonth, toMonth] is: that covers YoY (needs
  // latest-12) for every possible "latest month" >= fromMonth, and MoM
  // (needs latest-1) trivially. A SEPARATE query/array from `rows`, not a
  // wider single fetch — FacetFilterBar's facet option-counts must stay
  // anchored to the page's own displayed month range (`rows`), not quietly
  // include lookback months the user never selected.
  const priorFrom = monthToFirstOfMonthDate(shiftMonth(fromMonth, -12));
  const priorRowsPromise = fetchAllRows<ChannelSalesRow>(
    () =>
      supabase
        .schema("sales")
        .from<ChannelSalesRow>("vw_channel_sales_summary")
        .select(selectCols)
        .gte("bill_month", priorFrom)
        .lt("bill_month", from)
        .order("bill_month", { ascending: true })
        .order("id", { ascending: true }) as unknown as QueryChain<ChannelSalesRow>
  );

  const [rows, priorRows] = await Promise.all([rowsPromise, priorRowsPromise]);

  return <SaleSummaryClient rows={rows} priorRows={priorRows} />;
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
  searchParams: { fromMonth?: string; toMonth?: string };
}) {
  await requirePageAccess("sale-summary");

  const now = currentYm();
  // Default range: last 12 months touching today, same "reasonable default,
  // not the dawn of time" convention DateRangePicker's own presets use.
  const toMonth = searchParams.toMonth ?? now;
  const fromMonth = searchParams.fromMonth ?? shiftMonth(toMonth, -11);

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
      <div className="sticky top-14 z-30 -mx-4 mt-4 border-b border-line-soft bg-ground/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-ground/80 sm:-mx-6 sm:px-6">
        <MonthRangePicker fromMonth={fromMonth} toMonth={toMonth} />
      </div>

      <div className="mt-6">
        <SectionErrorBoundary label="Sale Summary">
          <Suspense fallback={<ChannelSalesSkeleton />}>
            <ChannelSalesSection fromMonth={fromMonth} toMonth={toMonth} />
          </Suspense>
        </SectionErrorBoundary>
      </div>
    </main>
  );
}
