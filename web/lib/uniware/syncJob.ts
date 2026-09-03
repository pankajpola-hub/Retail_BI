import "server-only";
import type { DataClient } from "@/lib/data/client";
import {
  searchSaleOrders,
  getSaleOrderItems,
  searchReturns,
  getReturn,
  uniwareRestEnabled,
  UniwareSoapError,
  UniwareRestError,
} from "@/lib/uniware/client";

/**
 * The actual Uniware sync job — extracted (2026-09-03) from
 * api/cron/uniware-sync/route.ts so the SAME logic can run two ways:
 * 1. The Vercel cron route (unchanged behavior, still auth-gated there).
 * 2. A standalone script (scripts/uniware-sync-standalone.ts), invoked from
 *    a GitHub Actions schedule instead of Vercel's — Vercel's Hobby plan
 *    caps cron invocations at once/day platform-wide, which is what made
 *    the item-enrichment queue permanently unable to catch up with ~500 new
 *    orders/day (see this file's history in route.ts before the split, or
 *    docs/audit/PROGRESS.md's 2026-09-03 entry). GitHub Actions has no such
 *    per-day cap and no 60s function-duration ceiling, so this can now run
 *    every few minutes and use a much larger batch if needed — same DB,
 *    same upsert RPCs, same idempotent-by-natural-key writes either way;
 *    only WHERE the HTTP/process call originates from changes.
 *
 * `import "server-only"` stays — this only ever runs under Next.js (the
 * route) or under `node --conditions=react-server` (the standalone script,
 * which neutralizes this exact guard the same way Next's RSC bundler does;
 * see that script's own header for why that's safe and not a workaround of
 * anything the guard actually protects against here).
 */

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
// invocation, not the scheduled sync) is the right tool for catching up
// further back, not this constant.
const HEADER_SYNC_WINDOW_DAYS = 7;
// SearchSaleOrder rejects any FromDate..ToDate span over ~31 days with a
// generic "An internal error occurred" fault (no specific error code) —
// confirmed live by binary search: 31 days succeeds, 32 fails.
const HEADER_CHUNK_DAYS = 30;
const HEADER_PAGE_SIZE = 100;
const HEADER_SAFETY_CAP = 5000; // orders per chunk; comfortably above any 30-day window seen so far

// Enrichment is the expensive phase (one GetSaleOrder call per order).
// History: 150 -> 60 -> 20 sequential, each still hitting Vercel's Hobby-
// plan 60s function-duration ceiling; 2026-09-03 added bounded concurrency
// (5 in flight) and raised to 60, reasoned safe under concurrency but only
// load-bearing for the Vercel route, which still has the 60s ceiling. The
// GitHub Actions runner has no such ceiling, so ITEM_ENRICHMENT_BATCH_SIZE
// can go much higher there — see the standalone script for its own value,
// passed in as a parameter rather than hardcoded here so the two callers
// can tune independently without editing this shared file.
const DEFAULT_ITEM_ENRICHMENT_BATCH_SIZE = 60;
const DEFAULT_ITEM_ENRICHMENT_CONCURRENCY = 5;

// Returns sync — same rolling-window-not-cursor shape as the header sync
// (Search Return has no "updated since" filter either, see
// 0069_raw_uniware_returns.sql's header) and the same <=30-day chunk cap as
// Search Order.
const RETURNS_SYNC_WINDOW_DAYS = 45;
const RETURNS_CHUNK_DAYS = 30;
const DEFAULT_RETURNS_DETAIL_BATCH_SIZE = 20;

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

function toUniwareDateOnly(d: Date): string {
  // Search Return's FromDate/ToDate accept "yyyy-MM-dd" ONLY — the more
  // common "yyyy-MM-dd HH:mm:ss" form is rejected (confirmed live).
  return d.toISOString().slice(0, 10);
}

export type SyncSummary = {
  headerSync: { pagesFetched: number; ordersUpserted: number; totalRecordsInWindow: number };
  itemSync: { ordersProcessed: number; ordersFailed: number; itemsUpserted: number };
  returnsSync: { enabled: boolean; codesFound: number; returnsProcessed: number; returnsFailed: number; returnsUpserted: number };
};

export type SyncJobOptions = {
  itemEnrichmentBatchSize?: number;
  itemEnrichmentConcurrency?: number;
  returnsDetailBatchSize?: number;
};

/**
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
 * logged and skipped rather than aborting the whole run.
 */
export async function runUniwareSync(admin: DataClient, options: SyncJobOptions = {}): Promise<{ ok: boolean; summary: SyncSummary; errors: string[] }> {
  const itemBatchSize = options.itemEnrichmentBatchSize ?? DEFAULT_ITEM_ENRICHMENT_BATCH_SIZE;
  const concurrency = options.itemEnrichmentConcurrency ?? DEFAULT_ITEM_ENRICHMENT_CONCURRENCY;
  const returnsBatchSize = options.returnsDetailBatchSize ?? DEFAULT_RETURNS_DETAIL_BATCH_SIZE;

  const startedAt = new Date();
  const summary: SyncSummary = {
    headerSync: { pagesFetched: 0, ordersUpserted: 0, totalRecordsInWindow: 0 },
    itemSync: { ordersProcessed: 0, ordersFailed: 0, itemsUpserted: 0 },
    returnsSync: { enabled: uniwareRestEnabled(), codesFound: 0, returnsProcessed: 0, returnsFailed: 0, returnsUpserted: 0 },
  };
  const errors: string[] = [];

  // "Started" row, written BEFORE any phase runs (audit B-08) — a killed
  // invocation is visible as a row with finished_at/success null that never
  // got a matching completion row, instead of an invisible gap.
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
      .rpc<{ code: string }[]>("fn_uniware_orders_needing_items", { p_limit: itemBatchSize });
    if (error) throw new Error(error.message);

    await mapWithConcurrency(queued ?? [], concurrency, async ({ code }) => {
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
  if (!summary.returnsSync.enabled) {
    // Deliberately NOT pushed to `errors` — a benign, expected skip, not a
    // failure. summary.returnsSync.enabled is the machine-readable signal.
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

    const uniqueCodes = Array.from(new Set(codes));
    summary.returnsSync.codesFound = uniqueCodes.length;

    await mapWithConcurrency(uniqueCodes.slice(0, returnsBatchSize), concurrency, async (code) => {
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

  return { ok, summary, errors };
}
