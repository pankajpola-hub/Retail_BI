import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { createClient } from "@/lib/data/client";
import { resolveAccess } from "@/lib/auth/access";

// Line-level detail behind ops.fn_monthly_fresh_disc_tracker (0029/0032) /
// ops.vw_monthly_fresh_disc_tracker (0027), scoped to one store + month
// (+ optional gender/subcategory/category, 0029/0032 — must match whatever
// the /targets page's filters currently show), so an admin can manually
// recompute the Fresh / Discounted totals from raw rows and confirm they
// match what /targets shows. Linked from the page via a "Download audit
// report" button next to the Store/Gender/Subcategory/Category/Month
// filters. Deliberately narrower than the page itself: /targets was widened
// in 0032 to let ebo_manager view the page (and write daily Remarks), but
// this download stays restricted to ho_admin/regional_manager/super_admin —
// a store-scoped manager role getting this line-level export wasn't asked
// for, so the role check below intentionally does NOT mirror the page's
// current (wider) gate.
//
// Paginates with a line_id keyset loop (0029) rather than a single request —
// PostgREST caps rows returned per request (1000 in supabase/config.toml),
// and a store-month of sales lines can exceed that easily, which would
// otherwise silently truncate the very report meant to prove the numbers
// are right.

type ProfileRow = { role: string };
type StoreRow = { store_id: string; store_name: string };

type AuditLineRow = {
  line_id: number;
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
  scheme_group_name: string | null;
  discount_pct: number | null;
  bucket: string;
  reason: string;
};

const ALLOWED_ROLES = ["ho_admin", "regional_manager", "super_admin"];

function ddmmyyyy(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  return `${d}-${m}-${y}`;
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: { code: "unauthorized", message: "Not signed in." } }, { status: 401 });
  }

  // Profile (for the role gate) and the store list (needed later purely to
  // resolve storeId -> store_name) don't depend on each other — both only
  // need the already-resolved user.id/session — so they run together
  // instead of two sequential round-trips. Occasionally fetches stores for a
  // caller who turns out to be forbidden and gets thrown away; that's cheap
  // and rare compared to paying the sequential cost on every allowed request.
  const [{ data: profile }, { data: stores }] = await Promise.all([
    supabase.schema("core").from<ProfileRow>("profiles").select("role").eq("user_id", user.id).maybeSingle(),
    supabase.schema("core").from<StoreRow>("stores").select("store_id, store_name"),
  ]);

  if (!profile || !ALLOWED_ROLES.includes(profile.role)) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "forbidden", message: "Only HO Admin / Regional Manager / Super Admin can download this report." },
      },
      { status: 403 }
    );
  }

  // 0079 feature gate, ANDed with the deliberately-narrower role list above
  // (see this file's header for why that list does NOT mirror the page's
  // wider gate). Without this, revoking `targets.audit_report.export` would
  // hide the button while leaving the URL fully working — a toggle that only
  // appears to do something. Also requires page access: you cannot export a
  // report you are not allowed to view.
  const access = await resolveAccess();
  if (access && (!access.can("targets.view") || !access.can("targets.audit_report.export"))) {
    return NextResponse.json(
      { ok: false, error: { code: "forbidden", message: "Not allowed to download this report." } },
      { status: 403 }
    );
  }

  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("store") ?? "";
  const month = searchParams.get("month") ?? "";
  // Optional, comma-separated (0037: filters are multi-select) — must match
  // the same filters the /targets page's Gender/Subcategory/Category
  // dropdowns applied, so the download reproduces exactly the numbers
  // currently on screen, not the whole store/month unfiltered.
  const parseMulti = (raw: string | null): string[] => (raw ? raw.split(",").filter(Boolean) : []);
  const genders = parseMulti(searchParams.get("gender"));
  const subcategories = parseMulti(searchParams.get("subcategory"));
  const categories = parseMulti(searchParams.get("category"));

  if (!storeId || !/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_query", message: "store and month (YYYY-MM) query params are required." } },
      { status: 400 }
    );
  }

  const store = stores?.find((s) => s.store_id === storeId);
  if (!store) {
    return NextResponse.json({ ok: false, error: { code: "unknown_store", message: "Unknown store." } }, { status: 400 });
  }

  const periodStart = `${month}-01`;
  const [yStr, mStr] = month.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  // First day of the following month, computed in JS rather than SQL so this
  // route never has to worry about the DB's date arithmetic/timezone —
  // exclusive upper bound (lt), so it never depends on knowing the month's
  // real length.
  const nextMonth = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);

  // Keyset-paginate on line_id (0029) rather than trusting a single request
  // to return every row — PostgREST caps rows per request (max_rows = 1000
  // in supabase/config.toml, and the self-hosted PostgREST is presumably
  // configured similarly), and a single store-month of line-level sales can
  // easily run into the thousands. Looping on "line_id > last seen" until a
  // page comes back short of the page size is backend-agnostic (works
  // whether the underlying cap is 1000 or something else) and doesn't
  // require a .range()/offset method the shared DataClient wrapper doesn't
  // expose (see web/lib/data/client.ts's QueryChain).
  const PAGE_SIZE = 1000;
  const rows: AuditLineRow[] = [];
  let cursor = 0;
  for (;;) {
    let query = supabase
      .schema("ops")
      .from<AuditLineRow>("vw_monthly_fresh_disc_audit_lines")
      .select(
        "line_id, bill_date, bill_no, bill_type, item_code, subcategory, gender, category, total_quantity, gross_amount, net_amount, discount_amount, scheme_name, scheme_group_name, discount_pct, bucket, reason"
      )
      .eq("store_id", storeId)
      .gte("bill_date", periodStart)
      .lt("bill_date", nextMonth)
      .gt("line_id", cursor);
    if (genders.length > 0) query = query.in("gender", genders);
    if (subcategories.length > 0) query = query.in("subcategory", subcategories);
    if (categories.length > 0) query = query.in("category", categories);
    const { data: page, error } = await query.order("line_id").limit(PAGE_SIZE);

    if (error) {
      return NextResponse.json({ ok: false, error: { code: "query_failed", message: error.message } }, { status: 400 });
    }
    const batch = page ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    const lastRow = batch[batch.length - 1];
    if (!lastRow) break;
    cursor = lastRow.line_id;
  }
  // Stable read order for the download itself (line_id pagination order
  // above is just for fetching correctly, not for what a reviewer wants to
  // read top-to-bottom).
  rows.sort((a, b) => a.bill_date.localeCompare(b.bill_date) || a.bill_no.localeCompare(b.bill_no) || a.item_code.localeCompare(b.item_code));

  const header = [
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
    "Discount %",
    "Scheme Name",
    "Bucket",
    "Why",
  ];
  const dataRows = rows.map((r) => [
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
    r.discount_pct ?? "",
    r.scheme_name ?? "",
    r.bucket,
    r.reason,
  ]);

  // Totals row per bucket, right under the data — saves the reviewer from
  // having to build a pivot table just to check the tracker's headline
  // numbers; the raw rows above still let them audit any individual line.
  const bucketTotals = new Map<string, number>();
  for (const r of rows) {
    bucketTotals.set(r.bucket, (bucketTotals.get(r.bucket) ?? 0) + Number(r.total_quantity));
  }
  const summaryRows = [
    [],
    ["Bucket", "Total Quantity"],
    ...[...bucketTotals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([bucket, qty]) => [bucket, qty]),
  ];

  const sheet = XLSX.utils.aoa_to_sheet([header, ...dataRows, ...summaryRows]);
  sheet["!cols"] = [
    { wch: 12 }, // Date
    { wch: 12 }, // Bill No
    { wch: 10 }, // Bill Type
    { wch: 16 }, // Item Code
    { wch: 10 }, // Gender
    { wch: 16 }, // Subcategory
    { wch: 10 }, // Quantity
    { wch: 13 }, // Gross Amount
    { wch: 13 }, // Net Amount
    { wch: 15 }, // Discount Amount
    { wch: 11 }, // Discount %
    { wch: 18 }, // Scheme Name
    { wch: 20 }, // Bucket
    { wch: 55 }, // Why
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Audit lines");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;

  const filterSuffix = [...genders, ...subcategories].join("-").replace(/[^a-z0-9-]+/gi, "");
  const filename = `targets-audit-${storeId}-${month}${filterSuffix ? `-${filterSuffix}` : ""}.xlsx`;

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
