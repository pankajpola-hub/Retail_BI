import { NextResponse } from "next/server";
import { cronAuthFailure } from "@/lib/cron/auth";
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
//
// Cut 45 -> 7 (2026-08-22): the real production bottleneck turned out to be
// HERE, not the item/returns batch sizes (those got cut 150->60->20 first,
// with NO effect — still a flat 60s FUNCTION_INVOCATION_TIMEOUT every time,
// which only makes sense if something ahead of them was already consuming
// the whole budget). A 45-day window walked in 30-day chunks means ~45
// sequential SearchSaleOrder page calls EVERY run, each a real network round
// trip from Vercel's US datacenter to this India-hosted Uniware tenant —
// plausibly slower per call than local dev's path, which is why this wasn't
// caught until the real deploy. A short daily window is also just the
// correct steady-state design once the historical backfill is done: nothing
// about routine daily maintenance needs to re-walk 45 days of history every
// single run. A separate, explicit backfill pass (a one-off wider-window
// invocation, not the scheduled cron) is the right tool for catching up
// further back, not this constant.
const HEADER_SYNC_WINDOW_DAYS = 7;
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
//
// Lowered from 150 to 60 (2026-08-22): confirmed live in production that
// 150+150 (items+returns) real sequential external-API calls in one
// invocation blew past the Hobby-plan function duration ceiling — a real
// FUNCTION_INVOCATION_TIMEOUT (504), not a maxDuration=60 config problem
// (that export is already set; the platform ceiling wins regardless). Local
// dev has no such ceiling, which is why this wasn't caught until the real
// deploy. Smaller batches, more runs — same "whatever doesn't fit gets
// picked up next time" design, just tuned to actually fit.
// Cut again, 60 -> 20 (still timed out at 60): Vercel's US datacenter to
// this India-hosted Uniware tenant is a much slower round trip per call than
// local dev's network path was — the real bottleneck is per-call latency,
// not raw batch size arithmetic.
//
// 2026-09-03: at 20/run x 1 run/day (vercel.json's old daily 3am schedule),
// throughput was ~20 orders enriched/day against a measured ~500 NEW header
// orders/day (sync_runs.header_orders_upserted) — the item queue could never
// catch up, it grew by ~480/day forever. Confirmed live: this app's ecomm
// revenue numbers were a small fraction of Uniware's own dashboard for the
// same days, because most orders never had item-level data at all. Fixed on
// two axes: (1) the sequential per-order loop below is now a bounded
// concurrency pool (ITEM_ENRICHMENT_CONCURRENCY) instead of one call at a
// time — wall-clock time for a batch is now bounded by the slowest call in
// each wave, not the sum of every call's latency, which is what actually
// caused the old 60-item batch to time out. (2) Batch size raised 20 -> 60:
// the earlier "60 -> 20 (still timed out at 60)" finding was measured under
// FULLY SEQUENTIAL execution; at concurrency=5, 60 items' wall-clock time is
// ~12 items'-worth (60/5), well under the 20-sequential baseline already
// confirmed to fit in 60s. A reasoned estimate, not measured live — check
// sync_runs' started_at/finished_at (0068) after this deploys and tune
// further from there, not blindly.
//
// vercel.json's schedule is UNCHANGED (still once daily) — Vercel's Hobby
// plan (the tier this project's earlier 60s maxDuration ceiling already
// establishes it's on) caps cron invocations at once per day platform-wide;
// an hourly schedule in vercel.json would not actually run hourly. Closing
// the remaining gap between ~500 new orders/day and whatever one daily run
// can now process needs either a Vercel plan upgrade (unlocks more frequent
// crons) or periodic manual backfill invocations — a product/cost decision,
// not something this change silently assumes. This code fix also does not
// touch the EXISTING backlog (only new incoming orders) — see this file's
// own long-standing note on a separate one-off backfill invocation being
// the right tool for that, not the scheduled cron.
const ITEM_ENRICHMENT_BATCH_SIZE = 60;
const ITEM_ENRICHMENT_CONCURRENCY = 5;

/** Bounded-concurrency map — runs `worker` over `items` with at most
 *  `concurrency` in flight at once, not one giant Promise.all (which would
 *  fire every request simultaneously and risk the upstream tenant rate-
 *  limiting or throttling a burst from one IP). */
async function mapWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  async function runOne(): Promise<void> {
    while (cursor < items.length) {
      const item = items[cursor++]!;
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runOne));
}

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
const RETURNS_DETAIL_BATCH_SIZE = 20; // lowered from 150 alongside ITEM_ENRICHMENT_BATCH_SIZE above — same reason

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
  // Fail-closed shared secret check — see lib/cron/auth.ts (audit B-07).
  const denied = cronAuthFailure(request);
  if (denied) return denied;

  const startedAt = new Date();
  const admin = await createAdminClient();
  const summary: SyncSummary = {
    headerSync: { pagesFetched: 0, ordersUpserted: 0, totalRecordsInWindow: 0 },
    itemSync: { ordersProcessed: 0, ordersFailed: 0, itemsUpserted: 0 },
    returnsSync: { enabled: uniwareRestEnabled(), codesFound: 0, returnsProcessed: 0, returnsFailed: 0, returnsUpserted: 0 },
  };
  const errors: string[] = [];

  // "Started" row, written BEFORE any phase runs (audit B-08). The
  // completion row at the end of this handler only ever gets written if the
  // handler reaches it — and the worst failure mode here is precisely the
  // one that prevents that: a platform FUNCTION_INVOCATION_TIMEOUT kills the
  // process outright, so a hung Uniware call used to leave NO row at all, an
  // invisible gap rather than a recorded failure (0068's own column comment
  // reads a null `success` as exactly that: "the route crashed before
  // writing this row").
  //
  // ops.fn_log_uniware_sync_run (0068) is insert-only — there is no update
  // door, and adding one is a migration, out of scope here — so this is a
  // second row rather than a row that gets completed in place. A killed
  // invocation is therefore visible in /api/cron/uniware-sync/status as a
  // row with finished_at null and success null that never got a matching
  // completion row with the same started_at.
  //
  // Best-effort, exactly like the completion write below: a logging failure
  // must not turn a working sync into a 500.
  try {
    await admin.schema("ops").rpc("fn_log_uniware_sync_run", {
      p_started_at: startedAt.toISOString(),
      p_finished_at: null,
      p_header_orders_upserted: 0,
      p_item_orders_processed: 0,
      p_item_orders_failed: 0,
      p_errors: [],
      p_success: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`sync_runs start log write: ${message}`);
  }

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

    await mapWithConcurrency(queued ?? [], ITEM_ENRICHMENT_CONCURRENCY, async ({ code }) => {
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
    });
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
    // Same bounded-concurrency fix as the item-enrichment phase above, same
    // reasoning (2026-09-03).
    await mapWithConcurrency(uniqueCodes.slice(0, RETURNS_DETAIL_BATCH_SIZE), ITEM_ENRICHMENT_CONCURRENCY, async (code) => {
      try {
        const detail = await getReturn(code);
        if (!detail) return;

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
    });
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
