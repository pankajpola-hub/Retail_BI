import { NextResponse } from "next/server";
import { cronAuthFailure } from "@/lib/cron/auth";
import { currentFinYear } from "@/app/api/_shared/finYear";
import { createAdminClient } from "@/lib/data/admin";
import { fetchAllSalesSourceRows, SalesSourceError } from "@/lib/salesSource/client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Rows are inserted in chunks of this size per RPC call — current-fiscal-
// year volume (a few thousand rows, per the reference doc's own current
// figures) is comfortably smaller than the 93,300-row master upload that
// first proved a single non-batched request can blow past Vercel's 60s
// Hobby-plan ceiling, but batching defensively costs nothing and matches
// this app's own established pattern (api/data-upload/process/[id]/commit's
// MASTER_BATCH_SIZE/SALE_BATCH_SIZE).
const UPSERT_BATCH_SIZE = 5000;

type SaleDetailRow = {
  fin_year: number;
  vouch_code: number;
  bill_no: string;
  barcode: string;
  bill_date: string; // "YYYY-MM-DD" over PostgREST
  bill_time: string | null;
  branch_name: string | null;
  agent_name: string | null;
  scheme_name: string | null;
  scheme_group_name: string | null;
  signed_net_amount: number | string | null;
  signed_gross_amount: number | string | null;
  signed_quantity: number | string | null;
  sold_mrp: number | string | null;
  color_name: string | null;
  category: string | null;
  sub_category: string | null;
  gender: string | null;
  season: string | null;
  market_segment: string | null;
};

// currentFinYear now lives in app/api/_shared/finYear.ts — moved there
// (unchanged) so app/api/sales-source/sale-detail can bound its own scan to
// the identical fiscal year rather than growing a second copy of the
// Apr-March boundary that could drift from this one (audit B-05).

// sale_detail's bill_date comes back "YYYY-MM-DD" over PostgREST (a real
// `date` column) — raw_logic.sales_transactions stores bill_date as TEXT in
// "DD/MM/YYYY" (parseSaleWorkbook.ts's own convention, matched by
// sales.vw_sale_transactions_export's to_date(..., 'DD/MM/YYYY') parse).
function toDDMMYYYY(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  return `${d}/${m}/${y}`;
}

/**
 * Keeps sale_detail's own sign — a RETURN arrives negative and is STORED
 * negative.
 *
 * This used to be `toUnsigned()` with a Math.abs(), on the belief (recorded
 * in the original sync plan) that raw_logic.sales_transactions holds unsigned
 * magnitudes with every consumer applying the sign itself from bill_type.
 * That belief was wrong, and it silently inflated every current-FY number in
 * the app until 2026-08-27. Two facts settle the convention:
 *
 * 1. The ERP's own Sale Register export — the source of truth the user
 *    reconciles against — emits returns NEGATIVE (qty -1, net -1150.00).
 * 2. Every Excel-uploaded row already in the table (19,254 of 24,010) stores
 *    them negative, and the whole sales.vw_ebo_* reporting chain
 *    (vw_ebo_sales_lines -> vw_ebo_bill -> vw_ebo_sales_daily/_weekly/
 *    _monthly, and 0092's vw_ebo_sale_attribute_lines) sums net_amount AS
 *    STORED with no sign logic of its own. It needs the stored value signed.
 *
 * With Math.abs() in place, a return was added to sales instead of subtracted
 * — an error of exactly 2x the returns value. Measured against the user's own
 * ERP export for 01-25 Aug 2026: Undri showed 621,403 against a true 585,315,
 * and quantity 501 against a true 471.
 *
 * lib/replenishment/compute.ts and lib/replenishment/mix.ts used to apply
 * `sign = bill_type === "RETURN" ? -1 : 1` on top of this; that is removed in
 * the same change, since double-signing an already-signed value is what made
 * those two pages wrong on the Excel-era rows.
 */
function toSigned(v: number | string | null): number {
  const n = v === null || v === undefined ? 0 : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Vercel Cron target — see vercel.json's schedule (added once the manual
 * parity check in the plan passes, per Pankaj's own rollout requirement).
 * Auth is the same shared-secret pattern as api/cron/uniware-sync/route.ts.
 *
 * Pulls sale_detail (lib/salesSource/client.ts — the live ERP source, a
 * second Supabase project) scoped to fin_year >= the CURRENT fiscal year
 * only. FY24-25/FY25-26 rows already in raw_logic.sales_transactions from
 * Excel uploads are never read or touched here — that scope is the actual
 * safety rail Pankaj asked for, not just a performance choice.
 *
 * No incremental cursor exists on sale_detail (confirmed in the reference
 * doc: nightly full Airbyte sync + a 01:15 reconciliation pass, no
 * updated_at column) — every run re-scans the whole current-FY window and
 * upserts through ops.fn_upsert_synced_sale_rows (0090), which is
 * idempotent on the same natural key the Excel-upload path already uses
 * (branch_name, bill_date, bill_no, item_code, line_seq).
 *
 * line_seq is DERIVED here, not a sale_detail column — sale_detail's own
 * grain differs (its primary key includes sold_mrp/bill_type, this app's
 * doesn't), so repeat lines for the same (branch, date, bill, barcode) are
 * numbered in fetch order, exactly like parseSaleWorkbook.ts numbers
 * repeat lines from an Excel file. Fetch order is the view's own full
 * primary key (fin_year, vouch_code, barcode, sold_mrp, bill_type, applied
 * below) — deterministic across runs, so re-running against unchanged data
 * assigns the same line_seq every time (0024's own idempotency rule).
 */
export async function GET(request: Request) {
  // Fail-closed shared secret check — see lib/cron/auth.ts (audit B-07).
  const denied = cronAuthFailure(request);
  if (denied) return denied;

  const startedAt = new Date();
  const finYear = currentFinYear(startedAt);
  const errors: string[] = [];
  let rowsUpserted = 0;

  try {
    // fetchAllSalesSourceRows signs in internally (ensureSignedIn) —
    // no separate getSalesSourceClient() call needed here.
    const rows = await fetchAllSalesSourceRows<SaleDetailRow>((c) =>
      c
        .from("sale_detail")
        .select(
          "fin_year, vouch_code, bill_no, barcode, bill_date, bill_time, branch_name, agent_name, scheme_name, scheme_group_name, signed_net_amount, signed_gross_amount, signed_quantity, sold_mrp, color_name, category, sub_category, gender, season, market_segment"
        )
        .gte("fin_year", finYear)
        .order("fin_year", { ascending: true })
        .order("vouch_code", { ascending: true })
        .order("barcode", { ascending: true })
        .order("sold_mrp", { ascending: true })
        .order("bill_type", { ascending: true })
    );

    // line_seq counter — keyed exactly like raw_logic.sales_transactions'
    // own natural key (minus line_seq itself), incremented in fetch order.
    const seqCounter = new Map<string, number>();
    const payload = rows
      .filter((r) => r.branch_name && r.bill_no && r.barcode && r.bill_date)
      .map((r) => {
        const billDate = toDDMMYYYY(r.bill_date);
        const key = `${r.branch_name}|${billDate}|${r.bill_no}|${r.barcode}`;
        const lineSeq = (seqCounter.get(key) ?? 0) + 1;
        seqCounter.set(key, lineSeq);

        return {
          branch_name: r.branch_name,
          bill_date: billDate,
          bill_no: r.bill_no,
          item_code: r.barcode,
          total_quantity: toSigned(r.signed_quantity),
          gross_amount: toSigned(r.signed_gross_amount),
          net_amount: toSigned(r.signed_net_amount),
          agent_name: r.agent_name,
          scheme_name: r.scheme_name,
          scheme_group_name: r.scheme_group_name,
          bill_time: r.bill_time,
          shade_name: r.color_name,
          category: r.category,
          subcategory: r.sub_category,
          season: r.season,
          market_segment: r.market_segment,
          gender: r.gender,
          mrp: r.sold_mrp === null || r.sold_mrp === undefined ? null : Number(r.sold_mrp),
          line_seq: lineSeq,
        };
      });

    const admin = await createAdminClient();
    for (let i = 0; i < payload.length; i += UPSERT_BATCH_SIZE) {
      const batch = payload.slice(i, i + UPSERT_BATCH_SIZE);
      const { data, error } = await admin.schema("ops").rpc<number>("fn_upsert_synced_sale_rows", { p_rows: batch });
      if (error) throw new Error(error.message);
      rowsUpserted += data ?? 0;
    }
  } catch (err) {
    const message =
      err instanceof SalesSourceError
        ? `${err.phase}: ${err.message}${err.hint ? ` (hint: ${err.hint})` : ""}`
        : err instanceof Error
          ? err.message
          : String(err);
    errors.push(message);
  }

  const ok = errors.length === 0;

  try {
    const admin = await createAdminClient();
    await admin.schema("ops").rpc("fn_log_sale_detail_sync_run", {
      p_started_at: startedAt.toISOString(),
      p_finished_at: new Date().toISOString(),
      p_fin_year: finYear,
      p_rows_upserted: rowsUpserted,
      p_errors: errors,
      p_success: ok,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`sync_runs log write: ${message}`);
  }

  return NextResponse.json({ ok, data: { finYear, rowsUpserted }, errors });
}
