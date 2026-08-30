import { Suspense } from "react";
import { createClient } from "@/lib/data/client";
import { requirePageAccess } from "@/lib/auth/roles";
import { TableSkeleton } from "@/components/ui/Skeleton";
import { SectionErrorBoundary } from "@/components/ui/SectionErrorBoundary";
import { MultiSelectFilter } from "@/components/ui/StoreFilter";
import { computeStockStatus } from "@/lib/stockStatus/aggregate";
import { StockStatusFacetedTable } from "./StockStatusFacetedTable";

// Always a live Shopify fetch (see lib/shopify/client.ts) - never
// statically cached, same reasoning app/(stock-details)/stock-details's
// page.tsx documents for its own force-dynamic.
export const dynamic = "force-dynamic";

function StockStatusSkeleton() {
  return <TableSkeleton rows={8} cols={8} />;
}

async function StockStatusContent({ godowns }: { godowns: string[] }) {
  const supabase = await createClient();
  const { rows, availableGodowns } = await computeStockStatus(supabase, { godowns });
  return (
    <>
      {/* Comparing Shopify's ecommerce SOH against the WHOLE warehouse
          (which can include non-ecom godowns, e.g. an EBO/offline bulk
          store) isn't the right comparison - scope WH stock down to the
          ecom godown(s) here before reading the mismatch numbers below. */}
      <div className="mb-4">
        <MultiSelectFilter
          paramName="godown"
          options={availableGodowns}
          selected={godowns}
          label="Godown"
          allLabel="All warehouse godowns"
        />
      </div>
      <StockStatusFacetedTable rows={rows} />
    </>
  );
}

export default async function StockStatusPage({
  searchParams,
}: {
  searchParams: { godown?: string };
}) {
  // Rides the existing "sales" page key rather than a new one - this is a
  // sub-page of /sales, not a separately-permissioned area.
  await requirePageAccess("sales");

  const godowns = (searchParams.godown ?? "").split(",").filter(Boolean);

  return (
    <main className="py-6">
      <h1 className="font-serif text-2xl">Stock Status</h1>
      <p className="mt-1 text-[12.5px] text-ink-3">
        WH stock (from sales.vw_stock_with_scheme) vs Shopify&apos;s live SOH, per style/colour. Shopify&apos;s side is
        always fetched fresh on load, so it reflects the current moment. Pick the ecom godown(s) below so the
        comparison isn&apos;t diluted by non-ecom warehouse stock.
      </p>

      <div className="mt-6">
        <SectionErrorBoundary label="Stock Status">
          <Suspense fallback={<StockStatusSkeleton />}>
            <StockStatusContent godowns={godowns} />
          </Suspense>
        </SectionErrorBoundary>
      </div>
    </main>
  );
}
