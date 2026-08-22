import "server-only";
import * as XLSX from "xlsx";
import type { DataClient } from "@/lib/data/client";
import { saveObjectFile } from "@/lib/storage/supabase";
import { computeReplenishmentRows, parseAssumptions, PRIORITY_ORDER } from "@/lib/replenishment/compute";

// Phase 5 (Track B) — scheduled re-runs of the three existing synchronous
// XLSX-download reports (app/api/replenishment/download,
// app/api/footfall/download, app/api/targets/monthly/audit-report), driven
// by ops.scheduled_exports (migration 0071) and the
// app/api/cron/scheduled-exports route.
//
// Unlike those on-demand routes, a scheduled run has no request query
// params (no store/date/filter selection from a live user) — each export
// type below picks the same sensible "whole scope" default a user would
// reach for if asked to just "send me the report": every store the owner
// can see, replenishment's own default assumptions, footfall's trailing 30
// days, targets' previous complete calendar month. Only `replenishment`
// reuses an already-factored-out compute function
// (computeReplenishmentRows) — footfall/targets never had one (their
// download routes build their report inline), so those two are rebuilt
// here in the same shape as their download routes rather than invented from
// scratch, still against the same views/columns.
//
// Runs with the service-role admin client (no end-user session exists for
// an unattended cron invocation), so store scoping that would normally come
// free from RLS (core.fn_user_store_ids(), which reads
// core.current_user_id() off a session GUC) is re-derived explicitly per
// owner in resolveOwnerStoreIds below — the same role/user_store_access
// logic core.fn_user_store_ids() encodes, just evaluated in TypeScript
// against an explicit owner_id instead of a session.

export const SCHEDULED_EXPORTS_BUCKET = "scheduled-exports";

const FREQUENCY_WINDOW_MS: Record<string, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

type ScheduledExportRow = {
  id: string;
  owner_id: string;
  export_type: "replenishment" | "footfall_completeness" | "targets_audit";
  frequency: "daily" | "weekly";
  last_run_at: string | null;
};

export type ScheduledExportRunSummary = {
  processed: number;
  succeeded: number;
  failed: number;
  errors: string[];
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function ddmmyyyy(isoDateStr: string): string {
  const [y, m, d] = isoDateStr.split("-");
  return `${d}-${m}-${y}`;
}

/**
 * Which stores an owner can see — the same role/user_store_access logic
 * core.fn_user_store_ids() (0003) encodes as SQL, evaluated here explicitly
 * because the admin client has no session for that function's
 * core.current_user_id() to resolve.
 */
async function resolveOwnerStoreIds(admin: DataClient, ownerId: string): Promise<string[]> {
  const { data: profile } = await admin
    .schema("core")
    .from<{ role: string }>("profiles")
    .select("role")
    .eq("user_id", ownerId)
    .maybeSingle();

  if (profile && (profile.role === "super_admin" || profile.role === "ho_admin")) {
    const { data: stores } = await admin.schema("core").from<{ store_id: string }>("stores").select("store_id");
    return (stores ?? []).map((s) => s.store_id);
  }

  const { data: access } = await admin
    .schema("core")
    .from<{ store_id: string }>("user_store_access")
    .select("store_id")
    .eq("user_id", ownerId);
  return (access ?? []).map((a) => a.store_id);
}

function bufferToXlsxFile(buffer: Buffer, filename: string): File {
  return new File([new Uint8Array(buffer)], filename, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

// ---------------------------------------------------------------------------
// replenishment — same rows/columns as app/api/replenishment/download,
// default assumptions (parseAssumptions() with no query params), unfiltered
// (whole network, matching the "send me the whole report" default).
// ---------------------------------------------------------------------------
async function buildReplenishmentReport(admin: DataClient): Promise<{ buffer: Buffer; filename: string }> {
  const assumptions = parseAssumptions(new URLSearchParams());
  const { rows } = await computeReplenishmentRows(admin, assumptions);
  const sorted = [...rows].sort(
    (a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority) || b.score - a.score
  );

  const header = [
    "Priority",
    "Score",
    "Style No.",
    "Color",
    "Store",
    "SOH",
    "Daily Demand",
    "Sales 30D",
    "Trend",
    "Cover (days)",
    "Reorder Point",
    "Target Stock",
    "Recommended Qty",
    "Warehouse Available",
    "Source",
    "Action",
    "Why",
  ];
  const dataRows = sorted.map((r) => [
    r.priority,
    Number(r.score.toFixed(1)),
    r.styleNo,
    r.color,
    r.storeName,
    r.soh,
    Number(r.dailyDemand.toFixed(2)),
    r.sales30d,
    r.trend ?? "",
    r.coverDays === null ? "" : Number(r.coverDays.toFixed(1)),
    Math.round(r.reorderPoint),
    Math.round(r.targetStock),
    r.recommendedQty,
    r.warehouseAvailable,
    r.source,
    r.action,
    r.why,
  ]);

  const sheet = XLSX.utils.aoa_to_sheet([header, ...dataRows]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Replenishment");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;

  return { buffer, filename: `replenishment-${isoDate(new Date())}.xlsx` };
}

// ---------------------------------------------------------------------------
// footfall_completeness — same shape/columns as app/api/footfall/download,
// but across every store the owner can see (that route takes one store per
// request) over a trailing 30-day window, with a Store column added.
// ---------------------------------------------------------------------------
type CompletenessRow = {
  store_id: string;
  date: string;
  has_footfall: boolean;
  footfall: number | null;
  remarks: string | null;
};
type DailySalesRow = { store_id: string | null; bill_date: string | null; sale_bills: number | string; net_sales: number | string };

async function buildFootfallCompletenessReport(admin: DataClient, ownerId: string): Promise<{ buffer: Buffer; filename: string }> {
  const storeIds = await resolveOwnerStoreIds(admin, ownerId);

  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 29);
  const fromStr = isoDate(from);
  const toStr = isoDate(to);

  const [{ data: stores }, { data: completeness }, { data: daily }] = await Promise.all([
    admin.schema("core").from<{ store_id: string; store_name: string }>("stores").select("store_id, store_name"),
    storeIds.length > 0
      ? admin
          .schema("ops")
          .from<CompletenessRow>("vw_footfall_completeness")
          .select("store_id, date, has_footfall, footfall, remarks")
          .in("store_id", storeIds)
          .gte("date", fromStr)
          .lte("date", toStr)
          .order("date")
      : Promise.resolve({ data: [] as CompletenessRow[] }),
    storeIds.length > 0
      ? admin
          .schema("sales")
          .from<DailySalesRow>("vw_ebo_sales_daily")
          .select("store_id, bill_date, sale_bills, net_sales")
          .in("store_id", storeIds)
          .gte("bill_date", fromStr)
          .lte("bill_date", toStr)
      : Promise.resolve({ data: [] as DailySalesRow[] }),
  ]);

  const storeNames = new Map((stores ?? []).map((s) => [s.store_id, s.store_name]));
  const salesByKey = new Map(
    (daily ?? []).filter((d) => d.store_id && d.bill_date).map((d) => [`${d.store_id}|${d.bill_date}`, d])
  );

  const header = ["Store", "Date", "Footfall", "Sale Bills", "Net Sales", "Conversion %", "Sales / Footfall", "Remarks"];
  const dataRows = (completeness ?? []).map((r) => {
    const sales = salesByKey.get(`${r.store_id}|${r.date}`);
    const bills = sales ? Number(sales.sale_bills) : 0;
    const net = sales ? Number(sales.net_sales) : 0;
    const hasFootfall = r.has_footfall && r.footfall !== null;
    const conversionPct = hasFootfall && r.footfall! > 0 ? Number(((bills / r.footfall!) * 100).toFixed(1)) : "";
    const salesPerFootfall = hasFootfall && r.footfall! > 0 ? Math.round(net / r.footfall!) : "";
    return [
      storeNames.get(r.store_id) ?? r.store_id,
      ddmmyyyy(r.date),
      hasFootfall ? r.footfall : "",
      bills,
      net,
      conversionPct,
      salesPerFootfall,
      r.remarks ?? "",
    ];
  });

  const sheet = XLSX.utils.aoa_to_sheet([header, ...dataRows]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Footfall completeness");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;

  return { buffer, filename: `footfall-completeness-${fromStr}-to-${toStr}.xlsx` };
}

// ---------------------------------------------------------------------------
// targets_audit — same line-level shape as
// app/api/targets/monthly/audit-report, but for the previous complete
// calendar month across every store the owner can see (that route takes one
// store + month per request), no gender/subcategory/category filters, with
// a Store column added. Same keyset (line_id) pagination as the on-demand
// route, for the same reason (PostgREST's per-request row cap).
// ---------------------------------------------------------------------------
type AuditLineRow = {
  line_id: number;
  store_id: string;
  bill_date: string;
  bill_no: string;
  bill_type: string;
  item_code: string;
  subcategory: string | null;
  gender: string | null;
  category: string | null;
  total_quantity: number;
  gross_amount: number;
  net_amount: number;
  discount_amount: number;
  scheme_name: string | null;
  bucket: string;
  reason: string;
};

async function buildTargetsAuditReport(admin: DataClient, ownerId: string): Promise<{ buffer: Buffer; filename: string }> {
  const storeIds = await resolveOwnerStoreIds(admin, ownerId);

  // Previous complete calendar month, computed in JS (same reasoning as the
  // on-demand route: never depend on the DB's date arithmetic/timezone).
  const now = new Date();
  const firstOfThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodStart = new Date(Date.UTC(firstOfThisMonth.getUTCFullYear(), firstOfThisMonth.getUTCMonth() - 1, 1));
  const periodStartStr = isoDate(periodStart);
  const nextMonthStr = isoDate(firstOfThisMonth);
  const monthLabel = periodStartStr.slice(0, 7);

  const [{ data: stores }] = await Promise.all([
    admin.schema("core").from<{ store_id: string; store_name: string }>("stores").select("store_id, store_name"),
  ]);
  const storeNames = new Map((stores ?? []).map((s) => [s.store_id, s.store_name]));

  const PAGE_SIZE = 1000;
  const rows: AuditLineRow[] = [];
  if (storeIds.length > 0) {
    let cursor = 0;
    for (;;) {
      const { data: page, error } = await admin
        .schema("ops")
        .from<AuditLineRow>("vw_monthly_fresh_disc_audit_lines")
        .select(
          "line_id, store_id, bill_date, bill_no, bill_type, item_code, subcategory, gender, category, total_quantity, gross_amount, net_amount, discount_amount, scheme_name, bucket, reason"
        )
        .in("store_id", storeIds)
        .gte("bill_date", periodStartStr)
        .lt("bill_date", nextMonthStr)
        .gt("line_id", cursor)
        .order("line_id")
        .limit(PAGE_SIZE);
      if (error) throw new Error(error.message);
      const batch = page ?? [];
      rows.push(...batch);
      if (batch.length < PAGE_SIZE) break;
      const last = batch[batch.length - 1];
      if (!last) break;
      cursor = last.line_id;
    }
  }
  rows.sort(
    (a, b) =>
      a.store_id.localeCompare(b.store_id) ||
      a.bill_date.localeCompare(b.bill_date) ||
      a.bill_no.localeCompare(b.bill_no) ||
      a.item_code.localeCompare(b.item_code)
  );

  const header = [
    "Store",
    "Date",
    "Bill No",
    "Bill Type",
    "Item Code",
    "Gender",
    "Subcategory",
    "Quantity",
    "Gross Amount",
    "Net Amount",
    "Discount Amount",
    "Scheme Name",
    "Bucket",
    "Why",
  ];
  const dataRows = rows.map((r) => [
    storeNames.get(r.store_id) ?? r.store_id,
    ddmmyyyy(r.bill_date),
    r.bill_no,
    r.bill_type,
    r.item_code,
    r.gender ?? "(no stock match)",
    r.subcategory ?? "(no stock match)",
    r.total_quantity,
    r.gross_amount,
    r.net_amount,
    r.discount_amount,
    r.scheme_name ?? "",
    r.bucket,
    r.reason,
  ]);

  const sheet = XLSX.utils.aoa_to_sheet([header, ...dataRows]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Audit lines");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;

  return { buffer, filename: `targets-audit-${monthLabel}.xlsx` };
}

async function buildReport(admin: DataClient, row: ScheduledExportRow): Promise<{ buffer: Buffer; filename: string }> {
  switch (row.export_type) {
    case "replenishment":
      return buildReplenishmentReport(admin);
    case "footfall_completeness":
      return buildFootfallCompletenessReport(admin, row.owner_id);
    case "targets_audit":
      return buildTargetsAuditReport(admin, row.owner_id);
    default: {
      const _exhaustive: never = row.export_type;
      throw new Error(`Unknown export_type: ${_exhaustive}`);
    }
  }
}

function isDue(row: ScheduledExportRow, now: Date): boolean {
  if (!row.last_run_at) return true;
  const windowMs = FREQUENCY_WINDOW_MS[row.frequency];
  if (!windowMs) return false;
  return now.getTime() - new Date(row.last_run_at).getTime() >= windowMs;
}

/**
 * Finds every due ops.scheduled_exports row (last_run_at null, or older
 * than its frequency's window), regenerates that report via the same
 * compute path its on-demand download route uses, uploads it to
 * SCHEDULED_EXPORTS_BUCKET, and updates last_run_at/last_file_path.
 * Called by app/api/cron/scheduled-exports's GET handler.
 *
 * One row's failure (a bad query, a storage error) is caught and recorded
 * in the summary rather than aborting the run — same "partial success beats
 * a hard stop" posture as app/api/cron/uniware-sync.
 */
export async function runDueScheduledExports(admin: DataClient): Promise<ScheduledExportRunSummary> {
  const summary: ScheduledExportRunSummary = { processed: 0, succeeded: 0, failed: 0, errors: [] };

  const { data: allRows, error } = await admin
    .schema("ops")
    .from<ScheduledExportRow>("scheduled_exports")
    .select("id, owner_id, export_type, frequency, last_run_at");
  if (error) {
    summary.errors.push(`scheduled_exports read: ${error.message}`);
    return summary;
  }

  const now = new Date();
  const due = (allRows ?? []).filter((row) => isDue(row, now));

  for (const row of due) {
    summary.processed += 1;
    try {
      const { buffer, filename } = await buildReport(admin, row);
      const path = `${row.owner_id}/${row.id}/${Date.now()}-${filename}`;
      await saveObjectFile(SCHEDULED_EXPORTS_BUCKET, path, bufferToXlsxFile(buffer, filename));

      const { error: updateError } = await admin
        .schema("ops")
        .from("scheduled_exports")
        .update({ last_run_at: now.toISOString(), last_file_path: path })
        .eq("id", row.id);
      if (updateError) throw new Error(updateError.message);

      summary.succeeded += 1;
    } catch (err) {
      summary.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      summary.errors.push(`${row.export_type} (${row.id}): ${message}`);
    }
  }

  return summary;
}
