import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { createClient } from "@/lib/data/client";

// Excel export of the footfall history shown on /footfall for a given store
// + date range — same store/date filters the page itself is currently
// showing, so the download always reproduces exactly what's on screen.
// Scoping: ops.vw_footfall_completeness is already RLS-filtered to
// core.fn_user_store_ids() (0019), and this route additionally checks the
// requested store against that same function directly so an out-of-scope
// store request gets a clean 403 instead of a silently empty file.

type ProfileRow = { role: string };
type StoreRow = { store_id: string; store_name: string };
type CompletenessRow = {
  store_id: string;
  date: string;
  has_footfall: boolean;
  footfall: number | null;
  remarks: string | null;
};
type DailyRow = { store_id: string | null; bill_date: string | null; sale_bills: number | string; net_sales: number | string };

const ALLOWED_ROLES = ["ebo_manager", "ho_admin", "super_admin"];

function ddmmyyyy(isoDateStr: string): string {
  const [y, m, d] = isoDateStr.split("-");
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

  // Neither of these depends on the other's result — both only need the
  // already-resolved user.id / session, so they run as one round-trip pair
  // instead of two sequential ones.
  const [{ data: profile }, { data: allowedStoreIds }] = await Promise.all([
    supabase.schema("core").from<ProfileRow>("profiles").select("role").eq("user_id", user.id).maybeSingle(),
    supabase.schema("core").rpc<string[]>("fn_user_store_ids"),
  ]);

  if (!profile || !ALLOWED_ROLES.includes(profile.role)) {
    return NextResponse.json(
      { ok: false, error: { code: "forbidden", message: "You don't have access to download footfall reports." } },
      { status: 403 }
    );
  }

  const storeIds = allowedStoreIds ?? [];

  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("store") ?? "";
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";

  const isIsoDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (!storeId || !isIsoDate(from) || !isIsoDate(to)) {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_query", message: "store, from (YYYY-MM-DD) and to (YYYY-MM-DD) query params are required." } },
      { status: 400 }
    );
  }

  if (!storeIds.includes(storeId)) {
    return NextResponse.json(
      { ok: false, error: { code: "forbidden", message: "You don't have access to this store's footfall." } },
      { status: 403 }
    );
  }

  // Store lookup and the two report queries are independent of each other
  // (none needs another's result, only the already-validated storeId/from/to)
  // — one round-trip instead of three sequential ones.
  const [{ data: stores }, { data: completeness, error: completenessErr }, { data: daily }] = await Promise.all([
    supabase.schema("core").from<StoreRow>("stores").select("store_id, store_name"),
    supabase
      .schema("ops")
      .from<CompletenessRow>("vw_footfall_completeness")
      .select("store_id, date, has_footfall, footfall, remarks")
      .eq("store_id", storeId)
      .gte("date", from)
      .lte("date", to)
      .order("date"),
    supabase
      .schema("sales")
      .from<DailyRow>("vw_ebo_sales_daily")
      .select("store_id, bill_date, sale_bills, net_sales")
      .eq("store_id", storeId)
      .gte("bill_date", from)
      .lte("bill_date", to),
  ]);

  const store = stores?.find((s) => s.store_id === storeId);
  if (!store) {
    return NextResponse.json({ ok: false, error: { code: "unknown_store", message: "Unknown store." } }, { status: 400 });
  }

  if (completenessErr) {
    return NextResponse.json({ ok: false, error: { code: "query_failed", message: completenessErr.message } }, { status: 400 });
  }

  const salesByDate = new Map((daily ?? []).filter((d) => d.bill_date).map((d) => [d.bill_date as string, d]));

  const header = ["Date", "Footfall", "Sale Bills", "Net Sales", "Conversion %", "Sales / Footfall", "Remarks"];
  const dataRows = (completeness ?? []).map((r) => {
    const sales = salesByDate.get(r.date);
    const bills = sales ? Number(sales.sale_bills) : 0;
    const net = sales ? Number(sales.net_sales) : 0;
    const hasFootfall = r.has_footfall && r.footfall !== null;
    const conversionPct = hasFootfall && r.footfall! > 0 ? Number(((bills / r.footfall!) * 100).toFixed(1)) : "";
    const salesPerFootfall = hasFootfall && r.footfall! > 0 ? Math.round(net / r.footfall!) : "";
    return [
      ddmmyyyy(r.date),
      hasFootfall ? r.footfall : "",
      bills,
      net,
      conversionPct,
      salesPerFootfall,
      r.remarks ?? "",
    ];
  });

  // Totals row — footfall/bills/net summed, conversion recomputed from the
  // totals rather than averaged row-by-row (averaging percentages would be
  // wrong once days with zero footfall are in the mix).
  const totalFootfall = (completeness ?? []).reduce((s, r) => s + (r.has_footfall && r.footfall !== null ? r.footfall : 0), 0);
  const totalBills = [...salesByDate.values()].reduce((s, d) => s + Number(d.sale_bills), 0);
  const totalNet = [...salesByDate.values()].reduce((s, d) => s + Number(d.net_sales), 0);
  const totalRow = [
    "Total",
    totalFootfall,
    totalBills,
    totalNet,
    totalFootfall > 0 ? Number(((totalBills / totalFootfall) * 100).toFixed(1)) : "",
    totalFootfall > 0 ? Math.round(totalNet / totalFootfall) : "",
    "",
  ];

  const sheet = XLSX.utils.aoa_to_sheet([header, ...dataRows, [], totalRow]);
  sheet["!cols"] = [
    { wch: 12 }, // Date
    { wch: 10 }, // Footfall
    { wch: 11 }, // Sale Bills
    { wch: 13 }, // Net Sales
    { wch: 13 }, // Conversion %
    { wch: 16 }, // Sales / Footfall
    { wch: 40 }, // Remarks
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Footfall");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;

  const filename = `footfall-${storeId}-${from}-to-${to}.xlsx`;

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
