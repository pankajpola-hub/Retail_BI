"use server";

import { createClient } from "@/lib/data/client";
import { computeTrendPoints, type DailyRow } from "@/lib/sales/aggregate";

/**
 * Phase 8 — smart components / drilldown. This is the exit gate the roadmap
 * names explicitly: "drilldown does not query until opened." Every other
 * server-rendered workspace component (renderSalesComponents.tsx) fetches
 * its data eagerly as part of the page's initial render — that's correct
 * for what's always on screen, but wrong for detail a user only sometimes
 * wants. This file exists so that detail query only ever runs from a
 * client-side click handler (StoreLeagueDrilldown.tsx), never from the
 * initial page render.
 *
 * Uses the same RLS-scoped client every page uses — no admin client, no
 * app-side store-id check. A caller who isn't authorized for storeId simply
 * gets zero rows back from sales.vw_ebo_sales_daily's own RLS
 * (core.fn_user_store_ids()), same boundary as everywhere else in the app.
 */
export async function getStoreDrilldownTrend(
  storeId: string,
  from: string,
  to: string
): Promise<{ label: string; value: number }[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated.");

  const { data, error } = await supabase
    .schema("sales")
    .from<DailyRow>("vw_ebo_sales_daily")
    .select("bill_date, store_id, net_sales")
    .eq("store_id", storeId)
    .gte("bill_date", from)
    .lte("bill_date", to)
    .order("bill_date");
  if (error) throw new Error(error.message);

  return computeTrendPoints(data);
}
