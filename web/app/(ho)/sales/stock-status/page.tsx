import { Suspense } from "react";
import { createClient } from "@/lib/data/client";
import { requirePageAccess } from "@/lib/auth/roles";
import { TableSkeleton } from "@/components/ui/Skeleton";
import { SectionErrorBoundary } from "@/components/ui/SectionErrorBoundary";
import { computeStockStatus } from "@/lib/stockStatus/aggregate";
import { StockStatusFacetedTable } from "./StockStatusFacetedTable";

// Always a live Shopify fetch (see lib/shopify/client.ts) - never
// statically cached, same reasoning app/(stock-details)/stock-details's
// page.tsx documents for its own force-dynamic.
export const dynamic = "force-dynamic";

function StockStatusSkeleton() {
  return <TableSkeleton rows={8} cols={8} />;
}

async function StockStatusContent() {
  const supabase = await createClient();
  const rows = await computeStockStatus(supabase);
  return <StockStatusFacetedTable rows={rows} />;
}

export default async function StockStatusPage() {
  // Rides the existing "sales" page key rather than a new one - this is a
  // sub-page of /sales, not a separately-permissioned area.
  await requirePageAccess("sales");

  return (
    <main className="py-6">
      <h1 className="font-serif text-2xl">Stock Status</h1>
      <p className="mt-1 text-[12.5px] text-ink-3">
        WH stock (from sales.vw_stock_with_scheme) vs Shopify&apos;s live SOH, per style/colour. Shopify&apos;s side is
        always fetched fresh on load, so it reflects the current moment.
      </p>

      <div className="mt-6">
        <SectionErrorBoundary label="Stock Status">
          <Suspense fallback={<StockStatusSkeleton />}>
            <StockStatusContent />
          </Suspense>
        </SectionErrorBoundary>
      </div>
    </main>
  );
}
