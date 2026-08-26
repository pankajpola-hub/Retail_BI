import { NextResponse } from "next/server";
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

// EBO fiscal year: April-March, 8-digit form per sale_detail_reference.md
// ("eight digits, e.g. 20262027") — matches sales.vw_sale_transactions_export's
// (0086) own Apr-start financial_year computation, just numeric instead of
// the view's "FY2026-27" text form.
function currentFinYear(d: Date): number {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1; // 1-12
  return m >= 4 ? y * 10000 + (y + 1) : (y - 1) * 10000 + y;
}

// sale_detail's bill_date comes back "YYYY-MM-DD" over PostgREST (a real
// `date` column) — raw_logic.sales_transactions stores bill_date as TEXT in
// "DD/MM/YYYY" (parseSaleWorkbook.ts's own convention, matched by
// sales.vw_sale_transactions_export's to_date(..., 'DD/MM/YYYY') parse).
function toDDMMYYYY(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  return `${d}/${m}/${y}`;
}

function toUnsigned(v: number | string | null): number {
  const n = v === null || v === undefined ? 0 : Number(v);
  return Number.isFinite(n) ? Math.abs(n) : 0;
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
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: { code: "unauthorized", message: "Not authorized." } }, { status: 401 });
  }

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
          total_quantity: toUnsigned(r.signed_quantity),
          gross_amount: toUnsigned(r.signed_gross_amount),
          net_amount: toUnsigned(r.signed_net_amount),
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
