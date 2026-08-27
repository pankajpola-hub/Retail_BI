import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { createClient as createDataClient, fetchAllRows } from "@/lib/data/client";

// Merged sale download — a single Excel export of the FULL accumulated
// raw_logic.sales_transactions history (every Sale-report upload ever
// committed through /api/data-upload/process/[id]/commit, across every
// fiscal year, already deduplicated by that table's (branch_name, bill_date,
// bill_no, item_code, line_seq) natural key from migration 0024 — merging is
// what the commit pipeline already does on every upload, so this route is a
// read, not a new merge step). Backed by sales.vw_sale_transactions_export
// (migration 0028/0033), which deliberately has no store-scoping or
// active-store join, unlike sales.vw_ebo_sales_lines — the gate here is
// entirely the role check below, same pattern as
// web/app/api/targets/monthly/audit-report/route.ts.
//
// Distinct from the existing per-upload Download link (raw original file,
// one fiscal year, redirected straight from MinIO) — this always reflects
// the CURRENT merged state of the database, not any single uploaded file.
// Surfaced from the Sale report section on the Data Upload page (no more
// separate button, per the 2026-08 UI consolidation), with an optional
// fiscal-year multi-select that maps to the `fy` query param here, e.g.
// ?fy=FY2025-26,FY2026-27 — omit it (or select nothing) to get every year.

type ProfileRow = { role: string };

type ExportRow = {
  branch_name: string;
  store_name: string | null;
  bill_date: string; // ISO from the view's to_date() cast
  financial_year: string; // e.g. 'FY2026-27', from migration 0033
  bill_no: string;
  bill_type: string;
  item_code: string;
  total_quantity: number;
  gross_amount: number;
  net_amount: number;
  discount_amount: number;
  agent_name: string | null;
  scheme_name: string | null;
  scheme_group_name: string | null;
  bill_time: string | null;
  line_seq: number;
};

const ALLOWED_ROLES = ["ho_admin", "super_admin"];

function ddmmyyyy(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  return `${d}-${m}-${y}`;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  // Comma-separated fiscal years, e.g. "FY2025-26,FY2026-27". Absent or
  // empty means "every year" (existing default behaviour, unchanged).
  const fyParam = searchParams.get("fy");
  const fiscalYears = fyParam
    ? fyParam.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  const supabase = await createDataClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: { code: "unauthorized", message: "Not signed in." } }, { status: 401 });
  }

  const { data: profile } = await supabase
    .schema("core")
    .from<ProfileRow>("profiles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!profile || !ALLOWED_ROLES.includes(profile.role)) {
    return NextResponse.json(
      { ok: false, error: { code: "forbidden", message: "Only HO Admin / Super Admin can download the merged sale file." } },
      { status: 403 }
    );
  }

  // Paginated with fetchAllRows, NOT a bare .limit(). Supabase's project
  // "Max Rows" setting caps every PostgREST response at 1000 regardless of
  // what .limit() asks for — the old .limit(200_000) here silently returned
  // exactly 1000 rows, no error, so "the FULL accumulated history" was in
  // fact ~4% of it (audit B-03; the cap was confirmed live 2026-08-25
  // against this very view, see lib/data/client.ts's own header).
  //
  // The whole chain is rebuilt inside the callback because a query builder
  // is single-use once .range()'d, and the .order() calls are load-bearing
  // rather than cosmetic: .range() is only a correct partition of the view
  // across separate REST calls when the sort is a TOTAL order. These five
  // columns are exactly raw_logic.sales_transactions' natural key from
  // migration 0024 (branch_name, bill_date, bill_no, item_code, line_seq),
  // so every row's position is deterministic and page boundaries are
  // stable — same reasoning as lib/replenishment/compute.ts:205-224.
  let rows: ExportRow[];
  try {
    rows = await fetchAllRows<ExportRow>(() => {
      let q = supabase
        .schema("sales")
        .from<ExportRow>("vw_sale_transactions_export")
        .select(
          "branch_name, store_name, bill_date, financial_year, bill_no, bill_type, item_code, total_quantity, gross_amount, net_amount, discount_amount, agent_name, scheme_name, scheme_group_name, bill_time, line_seq"
        );
      if (fiscalYears.length > 0) {
        q = q.in("financial_year", fiscalYears);
      }
      return q
        .order("bill_date")
        .order("branch_name")
        .order("bill_no")
        .order("item_code")
        .order("line_seq");
    });
  } catch (err) {
    // fetchAllRows throws on a PostgREST error rather than returning it —
    // mapped back to this route's existing 400 shape so callers see no change.
    return NextResponse.json(
      { ok: false, error: { code: "query_failed", message: err instanceof Error ? err.message : "Query failed." } },
      { status: 400 }
    );
  }

  const header = [
    "Branch Name",
    "Store Name",
    "Bill Date",
    "Financial Year",
    "Bill No",
    "Bill Type",
    "Item Code",
    "Total Quantity",
    "Gross Amount",
    "Net Amount",
    "Discount Amount",
    "Agent Name",
    "Scheme Name",
    "Scheme Group Name",
    "Bill Time",
  ];
  const dataRows = rows.map((r) => [
    r.branch_name,
    r.store_name ?? "",
    ddmmyyyy(r.bill_date),
    r.financial_year,
    r.bill_no,
    r.bill_type,
    r.item_code,
    r.total_quantity,
    r.gross_amount,
    r.net_amount,
    r.discount_amount,
    r.agent_name ?? "",
    r.scheme_name ?? "",
    r.scheme_group_name ?? "",
    r.bill_time ?? "",
  ]);

  const sheet = XLSX.utils.aoa_to_sheet([header, ...dataRows]);
  sheet["!cols"] = [
    { wch: 16 }, // Branch Name
    { wch: 20 }, // Store Name
    { wch: 12 }, // Bill Date
    { wch: 14 }, // Financial Year
    { wch: 14 }, // Bill No
    { wch: 10 }, // Bill Type
    { wch: 18 }, // Item Code
    { wch: 12 }, // Total Quantity
    { wch: 13 }, // Gross Amount
    { wch: 13 }, // Net Amount
    { wch: 15 }, // Discount Amount
    { wch: 18 }, // Agent Name
    { wch: 20 }, // Scheme Name
    { wch: 20 }, // Scheme Group Name
    { wch: 10 }, // Bill Time
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Merged Sale Data");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;

  const stamp = new Date().toISOString().slice(0, 10);
  const fySuffix = fiscalYears.length > 0 ? `-${fiscalYears.join("_").replace(/\s+/g, "")}` : "";
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="merged-sale-data${fySuffix}-${stamp}.xlsx"`,
    },
  });
}
