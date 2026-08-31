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
  const rows = await fetchAllRows<ChannelSalesRow>(
    () =>
      supabase
        .schema("sales")
        .from<ChannelSalesRow>("vw_channel_sales_summary")
        .select("id, branch_name, bill_month, party_name, channel_name, channel_type, channel_model, total_quantity, gross_amount, net_amount")
        .gte("bill_month", from)
        .lt("bill_month", toExclusive)
        .order("bill_month", { ascending: true })
        .order("id", { ascending: true }) as unknown as QueryChain<ChannelSalesRow>
  );

  return <SaleSummaryClient rows={rows} />;
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
      <div className="flex flex-wrap items-center justify-between gap-3">
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
