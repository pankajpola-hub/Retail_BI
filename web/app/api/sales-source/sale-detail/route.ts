import { NextResponse } from "next/server";
import { createClient as createAppClient } from "@/lib/data/client";
import { getSalesSourceClient, fetchAllSalesSourceRows, SalesSourceError, isRealError } from "@/lib/salesSource/client";

/**
 * Wiring-check / diagnostic endpoint for the second Supabase project
 * (sale_detail view) — see lib/salesSource/client.ts's own header. Gated
 * behind THIS app's own session (not the sales-source one) since this
 * queries and exposes real revenue-adjacent figures — a URL-only-knowledge
 * bar is not enough, same posture as api/replenishment/download/route.ts.
 *
 * Reports the three things Pankaj flagged as the ones that "will bite":
 * - lineCount: raw row count (one row per sold line) — the number to
 *   compare against the ~23,919 sanity check.
 * - distinctBills: count(distinct (fin_year, vouch_code)) — lines are not
 *   bills; a bare count(*) overstates bill count by grouping every line of
 *   a multi-item bill separately.
 * - unmatchedProductRows: rows where product_matched is false — real sales
 *   figures with no item attributes, not a data error to filter out.
 * - revenue: sum(signed_net_amount) — NOT net_amount, which doesn't exist,
 *   and NOT an unsigned amount column either: returns are stored positive
 *   in the ERP, so summing an unsigned column adds them to sales instead of
 *   netting them off (an ~11% error, per Pankaj). signed_net_amount is
 *   already sign-adjusted for that.
 */
export async function GET() {
  const appSupabase = await createAppClient();
  const {
    data: { user },
  } = await appSupabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: { code: "unauthorized", message: "Not signed in." } }, { status: 401 });
  }

  try {
    const sales = await getSalesSourceClient();

    const [lineResult, unmatchedResult] = await Promise.all([
      sales.from("sale_detail").select("*", { count: "exact", head: true }),
      sales.from("sale_detail").select("*", { count: "exact", head: true }).eq("product_matched", false),
    ]);
    // head:true has no response body by HTTP spec — logging status/count
    // alongside error is what actually shows whether a truthy `error` here
    // is real or the empty-body artifact isRealError filters out below.
    console.error("[sales-source/sale-detail] lineCount", {
      data: lineResult.data,
      error: lineResult.error,
      count: lineResult.count,
      status: lineResult.status,
      statusText: lineResult.statusText,
    });
    console.error("[sales-source/sale-detail] unmatchedProductRows", {
      data: unmatchedResult.data,
      error: unmatchedResult.error,
      count: unmatchedResult.count,
      status: unmatchedResult.status,
      statusText: unmatchedResult.statusText,
    });
    if (isRealError(lineResult.error)) throw new SalesSourceError("query", lineResult.error);
    if (isRealError(unmatchedResult.error)) throw new SalesSourceError("query", unmatchedResult.error);
    const lineCount = lineResult.count;
    const unmatchedProductRows = unmatchedResult.count;

    // No count(distinct ...) in PostgREST's query builder — paginate the
    // key columns and dedupe client-side.
    //
    // .order() here is NOT decoration (2026-08-26 — Pankaj traced a 791-row
    // undercount to exactly this being missing, then corrected a follow-up
    // fix of mine that only ordered by (fin_year, vouch_code)). .range()/
    // OFFSET-LIMIT pagination is only a correct partition of the table
    // across separate REST calls when the sort is a TOTAL order — unique
    // per row, with no ties. Ordering by just the two columns being deduped
    // on still ties on every line of the same bill (a bill has multiple
    // lines), so those rows can still shuffle across a page boundary
    // between the page-1 and page-2 REST calls, silently dropping or
    // duplicating rows with no error. sale_detail's actual line-level
    // primary key is (fin_year, vouch_code, barcode, mrp, bill_type) —
    // ordering by all five makes every row's position deterministic, so
    // page boundaries are stable regardless of which columns get selected.
    // Column is sold_mrp on this view specifically — the base table's own
    // `mrp` was renamed here to keep it distinct from the product master's
    // own mrp column (per Pankaj, 2026-08-26).
    // signed_net_amount pulled in the same paginated pass rather than a
    // second fetch — one full scan of the view serves both distinctBills
    // and revenue.
    const detailRows = await fetchAllSalesSourceRows<{ fin_year: string; vouch_code: string; signed_net_amount: number | string | null }>(
      (c) =>
        c
          .from("sale_detail")
          .select("fin_year, vouch_code, signed_net_amount")
          .order("fin_year", { ascending: true })
          .order("vouch_code", { ascending: true })
          .order("barcode", { ascending: true })
          .order("sold_mrp", { ascending: true })
          .order("bill_type", { ascending: true })
    );
    const distinctBills = new Set(detailRows.map((r) => `${r.fin_year}::${r.vouch_code}`)).size;
    const revenue = detailRows.reduce((sum, r) => sum + Number(r.signed_net_amount ?? 0), 0);

    return NextResponse.json({
      ok: true,
      data: { lineCount, distinctBills, unmatchedProductRows, revenue },
    });
  } catch (err) {
    // Server-log the full object regardless of shape — a bare `err.message`
    // is exactly what left the previous version of this route unable to
    // tell a sign-in failure from a query failure: Object.getOwnPropertyNames
    // catches fields a plain JSON.stringify(err) silently drops (Error's own
    // `message`/`stack` are non-enumerable), and SalesSourceError's
    // code/details/hint/status/phase are ordinary enumerable properties on
    // top of that.
    console.error("[sales-source/sale-detail]", JSON.stringify(err, Object.getOwnPropertyNames(err as object)));

    const isSalesSourceError = err instanceof SalesSourceError;
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "sales_source_query_failed",
          message: err instanceof Error ? err.message : "Query failed.",
          phase: isSalesSourceError ? err.phase : undefined,
          sourceCode: isSalesSourceError ? err.code : undefined,
          details: isSalesSourceError ? err.details : undefined,
          hint: isSalesSourceError ? err.hint : undefined,
          status: isSalesSourceError ? err.status : undefined,
        },
      },
      { status: 500 }
    );
  }
}
