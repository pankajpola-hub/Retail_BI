import type { DataClient, QueryChain } from "@/lib/data/client";
import { fetchAllRows } from "@/lib/data/client";
import { ProductAttributeSalesTable } from "@/app/(ho)/sales/ProductAttributeSalesTable";
import type { SaleAttributeLineRow } from "@/lib/sales/attributeBreakdown";

/**
 * D-05 parity item 2 (docs/audit/D-frontend.md, "Sales -> Workspace parity
 * diff") — the product-attribute breakdown (Season+Year default,
 * drag-to-combine chips), ported from app/(ho)/sales/page.tsx's
 * ProductAttributeSection.
 *
 * Deliberately its OWN family module, separate from renderSalesComponents.tsx,
 * rather than a third field bolted onto SalesComponentData/fetchRaw there.
 * Every fetch inside renderSalesComponents.tsx's fetchRaw() reads a
 * pre-aggregated rollup view (vw_ebo_sales_daily/weekly/monthly/hourly/...);
 * this is the only LINE-grain query anywhere in the Sales family — same
 * "must not be able to hold up sections that don't need it" reasoning
 * sales/page.tsx's own ProductAttributeSection header already states, now
 * doubled: on Workspace, holding up the shared Promise.all would also delay
 * every OTHER Sales tile on the same page (KPI grid, trend chart, league,
 * ...), not just this one section. Kept as a fully separate
 * gated/streamed family (own needsProductAttributeData flag, own promise, own
 * FamilyItem/Suspense/SectionErrorBoundary in workspace/page.tsx) so a
 * workspace that never adds this component never pays for
 * vw_ebo_sale_attribute_lines at all, and one that does never makes the rest
 * of the Sales tiles wait on it.
 *
 * fetchAllRows() + the three-key .order() below exist for the same reason
 * sales/page.tsx's ProductAttributeSection documents at length: PostgREST's
 * project "Max Rows" setting silently caps every response at 1000 rows
 * regardless of .limit(), and .range()-based pagination is only a correct
 * partition of the view across separate REST calls when the query carries a
 * near-total ORDER BY — see lib/data/client.ts's own fetchAllRows comment and
 * the 791-row undercount bug that discipline was adopted to prevent.
 *
 * ProductAttributeSalesTable is reused verbatim (unmodified) — it is already
 * "use client" and takes only the serializable `lines` prop, exactly as the
 * audit's port note (d) called for.
 */
export type ProductAttributeComponentScope = {
  supabase: DataClient;
  storeIds: string[];
  from: string;
  to: string;
};

export async function fetchProductAttributeComponentData(
  scope: ProductAttributeComponentScope
): Promise<SaleAttributeLineRow[]> {
  const { supabase, storeIds, from, to } = scope;
  const applyStore = <T extends { eq: (c: string, v: string) => T; in: (c: string, v: string[]) => T }>(q: T): T => {
    if (storeIds.length === 0) return q;
    if (storeIds.length === 1) return q.eq("store_id", storeIds[0]!);
    return q.in("store_id", storeIds);
  };

  return fetchAllRows<SaleAttributeLineRow>(() =>
    applyStore(
      supabase
        .schema("sales")
        .from<SaleAttributeLineRow>("vw_ebo_sale_attribute_lines")
        .select(
          "store_id, bill_date, bill_no, bill_type, total_quantity, gross_amount, net_amount, season, market_segment, category, subcategory, gender, size_group, shade_name, mrp"
        )
        .gte("bill_date", from)
        .lte("bill_date", to)
        // See this file's header — required for .range()-based pagination to
        // be a correct partition of the view, not decoration. Same three keys
        // sales/page.tsx's ProductAttributeSection orders by.
        .order("bill_date", { ascending: true })
        .order("bill_no", { ascending: true })
        .order("item_code", { ascending: true })
    ) as unknown as QueryChain<SaleAttributeLineRow>
  );
}

export function ProductAttributeTable({ data }: { data: SaleAttributeLineRow[] }) {
  return <ProductAttributeSalesTable lines={data} />;
}

export const PRODUCT_ATTRIBUTE_COMPONENT_RENDERERS: Record<string, (props: { data: SaleAttributeLineRow[] }) => JSX.Element> = {
  product_attribute_table: ProductAttributeTable,
};
