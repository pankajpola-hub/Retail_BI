import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/data/admin";
import {
  searchSaleOrders,
  getSaleOrderItems,
  searchReturns,
  getReturn,
  uniwareRestEnabled,
  UniwareSoapError,
  UniwareRestError,
} from "@/lib/uniware/client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Rolling window, not a cursor — see 0063_raw_uniware.sql's header for why
// SearchSaleOrder has no "updated since" filter to track one against.
const HEADER_SYNC_WINDOW_DAYS = 45;
// SearchSaleOrder rejects any FromDate..ToDate span over ~31 days with a
// generic "An internal error occurred" fault (no specific error code) —
// confirmed live by binary search: 31 days succeeds, 32 fails. The total
// lookback window above is walked in chunks this wide, same reasoning as
// VMS_Peppermint's Search Return integration hitting an analogous (documented,
// ~30-45 day) cap on a different Uniware endpoint.
const HEADER_CHUNK_DAYS = 30;
const HEADER_PAGE_SIZE = 100;
const HEADER_SAFETY_CAP = 5000; // orders per chunk; comfortably above any 30-day window seen so far

// Enrichment is the expensive phase (one GetSaleOrder call per order) — capped
// per invocation so a large backfill can't run into Vercel's function
// duration limit. Whatever's left in the queue (items_synced_at is null) just
// gets picked up on the next scheduled run.
const ITEM_ENRICHMENT_BATCH_SIZE = 150;

// Returns sync — same rolling-window-not-cursor shape as the header sync
// (Search Return has no "updated since" filter either, see
// 0069_raw_uniware_returns.sql's header) and the same <=30-day chunk cap as
// Search Order (see HEADER_CHUNK_DAYS above), confirmed live by
// D:\Py\VMS_Peppermint against this same tenant's Search Return endpoint.
const RETURNS_SYNC_WINDOW_DAYS = 45;
const RETURNS_CHUNK_DAYS = 30;
// Get Return is one REST call PER RETURN CODE (Search Return gives back bare
// codes only, see client.ts's searchReturns) — same per-item cost shape and
// same reason for a per-invocation cap as ITEM_ENRICHMENT_BATCH_SIZE above,
// protecting Vercel's function duration limit on a large backfill. Whatever
// doesn't fit this run is simply re-found by the next run's Search Return
// pass (the window is re-searched every time, nothing is queued).
const RETURNS_DETAIL_BATCH_SIZE = 150;

function toUniwareDateOnly(d: Date): string {
  // Search Return's FromDate/ToDate accept "yyyy-MM-dd" ONLY — the more
  // common "yyyy-MM-dd HH:mm:ss" form is rejected (confirmed live by VMS
  // against this tenant). Date.toISOString() always starts with that shape.
  return d.toISOString().slice(0, 10);
}

type SyncSummary = {
  headerSync: { pagesFetched: number; ordersUpserted: number; totalRecordsInWindow: number };
  itemSync: { ordersProcessed: number; ordersFailed: number; itemsUpserted: number };
  returnsSync: { enabled: boolean; codesFound: number; returnsProcessed: number; returnsFailed: number; returnsUpserted: number };
};

/**
 * Vercel Cron target — see vercel.json's schedule. Auth is a shared secret
 * Vercel sends as `Authorization: Bearer ${CRON_SECRET}` on scheduled
 * invocations (https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs);
 * anything else (a stray request, a manual curl without the secret) is
 * rejected before any Uniware call is made.
 *
 * Three independent phases, run sequentially in one invocation:
 *   1. Header sync  — SearchSaleOrder over a rolling window, upserted via
 *      ops.fn_upsert_uniware_orders.
 *   2. Item sync    — GetSaleOrder for whatever's still queued
 *      (items_synced_at is null), oldest-first-priority via
 *      ops.fn_uniware_orders_needing_items, upserted via
 *      ops.fn_upsert_uniware_order_items.
 *   3. Returns sync — a DIFFERENT Uniware API (REST v1 OAuth2, not SOAP —
 *      see lib/uniware/client.ts's Returns section header): Search Return
 *      over a rolling window for return codes, then Get Return per code,
 *      upserted via ops.fn_upsert_uniware_returns. Skipped (not failed)
 *      when UNIWARE_REST_USERNAME/PASSWORD aren't configured yet.
 * All three phases are individually resilient: one bad order/page/return is
 * logged and skipped rather than aborting the whole run, since a partial
 * sync now followed by a clean one on the next scheduled tick beats a hard
 * failure.
 */
export async function GET(request: Request) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: { code: "unauthorized", message: "Not authorized." } }, { status: 401 });
  }

  const startedAt = new Date();
  const admin = await createAdminClient();
  const summary: SyncSummary = {
    headerSync: { pagesFetched: 0, ordersUpserted: 0, totalRecordsInWindow: 0 },
    itemSync: { ordersProcessed: 0, ordersFailed: 0, itemsUpserted: 0 },
    returnsSync: { enabled: uniwareRestEnabled(), codesFound: 0, returnsProcessed: 0, returnsFailed: 0, returnsUpserted: 0 },
  };
  const errors: string[] = [];

  // ---- Phase 1: header sync ----
  // Walked in <=30-day chunks across the full lookback window (see
  // HEADER_CHUNK_DAYS above) — a single chunk failing (logged, not thrown)
  // doesn't stop the others from running.
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - HEADER_SYNC_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  let chunkFrom = windowStart;
  while (chunkFrom < windowEnd) {
    const chunkTo = new Date(Math.min(chunkFrom.getTime() + HEADER_CHUNK_DAYS * 24 * 60 * 60 * 1000, windowEnd.getTime()));
    try {
      let displayStart = 0;
      while (displayStart < HEADER_SAFETY_CAP) {
        const { orders, totalRecords } = await searchSaleOrders(chunkFrom, chunkTo, displayStart, HEADER_PAGE_SIZE);
        summary.headerSync.totalRecordsInWindow += displayStart === 0 ? totalRecords : 0;
        summary.headerSync.pagesFetched += 1;

        if (orders.length > 0) {
          const payload = orders.map((o) => ({
            code: o.code,
            display_order_code: o.displayOrderCode,
            channel: o.channel,
            status: o.status,
            order_datetime: o.orderDatetime,
            created_on: o.createdOn,
            updated_on: o.updatedOn,
            notification_email: o.notificationEmail,
            notification_mobile: o.notificationMobile,
          }));
          const { data, error } = await admin.schema("ops").rpc<number>("fn_upsert_uniware_orders", { p_rows: payload });
          if (error) throw new Error(error.message);
          summary.headerSync.ordersUpserted += data ?? 0;
        }

        displayStart += HEADER_PAGE_SIZE;
        if (orders.length < HEADER_PAGE_SIZE || displayStart >= totalRecords) break;
      }
    } catch (err) {
      const message = err instanceof UniwareSoapError ? err.message : err instanceof Error ? err.message : String(err);
      errors.push(`header sync (${chunkFrom.toISOString().slice(0, 10)}..${chunkTo.toISOString().slice(0, 10)}): ${message}`);
    }
    chunkFrom = chunkTo;
  }

  // ---- Phase 2: item enrichment ----
  try {
    const { data: queued, error } = await admin
      .schema("ops")
      .rpc<{ code: string }[]>("fn_uniware_orders_needing_items", { p_limit: ITEM_ENRICHMENT_BATCH_SIZE });
    if (error) throw new Error(error.message);

    for (const { code } of queued ?? []) {
      try {
        const items = await getSaleOrderItems(code);
        const payload = items.map((it) => ({
          item_code: it.itemCode,
          item_sku: it.itemSku,
          item_name: it.itemName,
          size: it.size,
          color: it.color,
          brand: it.brand,
          status_code: it.statusCode,
          facility_code: it.facilityCode,
          selling_price: it.sellingPrice,
          total_price: it.totalPrice,
          shipping_charges: it.shippingCharges,
          gift_wrap: it.giftWrapCharges,
          mrp: it.mrp,
          discount: it.discount,
          hsn_code: it.hsnCode,
          created_on: it.createdOn,
          updated_on: it.updatedOn,
        }));
        const { data: upserted, error: upsertError } = await admin
          .schema("ops")
          .rpc<number>("fn_upsert_uniware_order_items", { p_sale_order_code: code, p_rows: payload });
        if (upsertError) throw new Error(upsertError.message);

        summary.itemSync.ordersProcessed += 1;
        summary.itemSync.itemsUpserted += upserted ?? 0;
      } catch (err) {
        summary.itemSync.ordersFailed += 1;
        const message = err instanceof UniwareSoapError ? err.message : err instanceof Error ? err.message : String(err);
        errors.push(`item sync (${code}): ${message}`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`item sync queue read: ${message}`);
  }

  // ---- Phase 3: returns sync ----
  // A different API from phases 1/2 (REST v1 OAuth2, not SOAP — see
  // client.ts's Returns section header) with its own credential pair, so it
  // may not be configured yet even when the SOAP side is fully working;
  // that's a deliberately quiet skip, not an error, since this route runs
  // unattended on a schedule.
  if (!summary.returnsSync.enabled) {
    // Deliberately NOT pushed to `errors` — this would flip `ok: false` on
    // every scheduled run until REST credentials are configured, misreporting
    // a benign, expected skip as a failure. summary.returnsSync.enabled is
    // the machine-readable signal; nothing else needs to change to pick this
    // phase back up once UNIWARE_REST_USERNAME/PASSWORD are set.
  } else {
    const returnsWindowEnd = new Date();
    const returnsWindowStart = new Date(returnsWindowEnd.getTime() - RETURNS_SYNC_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const codes: string[] = [];
    let returnsChunkFrom = returnsWindowStart;
    while (returnsChunkFrom < returnsWindowEnd) {
      const returnsChunkTo = new Date(
        Math.min(returnsChunkFrom.getTime() + RETURNS_CHUNK_DAYS * 24 * 60 * 60 * 1000, returnsWindowEnd.getTime())
      );
      try {
        const chunkCodes = await searchReturns(toUniwareDateOnly(returnsChunkFrom), toUniwareDateOnly(returnsChunkTo));
        codes.push(...chunkCodes);
      } catch (err) {
        const message = err instanceof UniwareRestError ? err.message : err instanceof Error ? err.message : String(err);
        errors.push(
          `returns search (${toUniwareDateOnly(returnsChunkFrom)}..${toUniwareDateOnly(returnsChunkTo)}): ${message}`
        );
      }
      returnsChunkFrom = returnsChunkTo;
    }

    // De-dupe (adjacent chunks can share their boundary day, same as VMS's
    // sync_return_tracking_numbers) before spending a Get Return call on each.
    const uniqueCodes = Array.from(new Set(codes));
    summary.returnsSync.codesFound = uniqueCodes.length;

    // Capped per invocation for the same duration-limit reason as
    // ITEM_ENRICHMENT_BATCH_SIZE — nothing is queued for "the rest", the next
    // run's Search Return pass simply re-finds whatever didn't fit this time.
    for (const code of uniqueCodes.slice(0, RETURNS_DETAIL_BATCH_SIZE)) {
      try {
        const detail = await getReturn(code);
        if (!detail) continue;

        const payload = [
          {
            reverse_pickup_code: detail.reversePickupCode,
            sale_order_code: detail.saleOrderCode,
            return_awb: detail.returnAwb,
            status: detail.status,
            created_on: detail.createdOn,
            updated_on: detail.updatedOn,
            raw_response: detail.raw,
          },
        ];
        const { data: upserted, error } = await admin
          .schema("ops")
          .rpc<number>("fn_upsert_uniware_returns", { p_rows: payload });
        if (error) throw new Error(error.message);

        summary.returnsSync.returnsProcessed += 1;
        summary.returnsSync.returnsUpserted += upserted ?? 0;
      } catch (err) {
        summary.returnsSync.returnsFailed += 1;
        const message = err instanceof UniwareRestError ? err.message : err instanceof Error ? err.message : String(err);
        errors.push(`returns detail (${code}): ${message}`);
      }
    }
  }

  const ok = errors.length === 0;

  // Log this invocation regardless of outcome — see 0068_uniware_sync_runs.sql's
  // header for why nothing else was reading this response before now. Best-effort:
  // a logging failure shouldn't turn a real (or already-failed) sync into a 500,
  // so it's appended to `errors` (visible in this response) rather than thrown.
  try {
    await admin.schema("ops").rpc("fn_log_uniware_sync_run", {
      p_started_at: startedAt.toISOString(),
      p_finished_at: new Date().toISOString(),
      p_header_orders_upserted: summary.headerSync.ordersUpserted,
      p_item_orders_processed: summary.itemSync.ordersProcessed,
      p_item_orders_failed: summary.itemSync.ordersFailed,
      p_errors: errors,
      p_success: ok,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`sync_runs log write: ${message}`);
  }

  return NextResponse.json({ ok, data: summary, errors });
}
