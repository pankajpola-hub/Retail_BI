import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { createClient as createDataClient } from "@/lib/data/client";

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
// No .range()/.offset() on the shared DataClient (lib/data/client.ts's
// QueryChain deliberately only exposes the methods already used elsewhere —
// see its header). Single generous .limit() instead, same style as
// web/app/(stock-details)/stock-details/page.tsx's .limit(20000) for its
// own full-table export. One fiscal year alone verified at ~21k real rows
// (migration 0024's header); 200k comfortably covers many years of
// accumulated history before this needs revisiting.
const EXPORT_ROW_LIMIT = 200_000;

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

  let query = supabase
    .schema("sales")
    .from<ExportRow>("vw_sale_transactions_export")
    .select(
      "branch_name, store_name, bill_date, financial_year, bill_no, bill_type, item_code, total_quantity, gross_amount, net_amount, discount_amount, agent_name, scheme_name, scheme_group_name, bill_time, line_seq"
    );
  if (fiscalYears.length > 0) {
    query = query.in("financial_year", fiscalYears);
  }
  const { data, error } = await query
    .order("bill_date")
    .order("branch_name")
    .order("bill_no")
    .order("item_code")
    .order("line_seq")
    .limit(EXPORT_ROW_LIMIT);

  if (error) {
    return NextResponse.json({ ok: false, error: { code: "query_failed", message: error.message } }, { status: 400 });
  }
  const rows = data ?? [];

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
