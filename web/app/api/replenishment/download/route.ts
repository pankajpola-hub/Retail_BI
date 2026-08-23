import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { createClient } from "@/lib/data/client";
import { PAGE_ROLE_DEFAULTS, type AppRole } from "@/lib/auth/roles";
import { resolveAccess } from "@/lib/auth/access";
import { computeReplenishmentRows, filterRows, parseAssumptions, PRIORITY_ORDER, fmt } from "@/lib/replenishment/compute";

// Full detailed export behind the Replenishment page's "Download detailed
// report" link — mirrors the page's own filters/assumptions/weights exactly
// (same computeReplenishmentRows + filterRows as page.tsx, see
// lib/replenishment/compute.ts) but writes every matching row, not just one
// page of it. Role check matches the page's own gate (PAGE_ROLE_DEFAULTS
// for "replenishment"), not requirePageAccess() directly, since that
// function is built around a redirect() and this is an API route.

type ProfileRow = { role: AppRole };

export async function GET(request: NextRequest) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: { code: "unauthorized", message: "Not signed in." } }, { status: 401 });
  }

  const { data: profile } = await supabase.schema("core").from<ProfileRow>("profiles").select("role").eq("user_id", user.id).maybeSingle();
  if (!profile || !PAGE_ROLE_DEFAULTS.replenishment.includes(profile.role)) {
    return NextResponse.json({ ok: false, error: { code: "forbidden", message: "Not allowed to download this report." } }, { status: 403 });
  }

  // 0079 feature gate, ANDed with the role check above rather than replacing
  // it. Hiding the link on the page is view tailoring; without this, anyone
  // who knows the URL could still pull the full network dataset after an
  // admin revoked their export permission — which would make
  // `replenishment.recommendations.export` a toggle that only appears to work.
  // This also covers the page's own `replenishment.recommendations.view` key:
  // you cannot export a report you are not allowed to see.
  const access = await resolveAccess();
  if (
    access &&
    (!access.can("replenishment.recommendations.view") ||
      !access.can("replenishment.recommendations.export"))
  ) {
    return NextResponse.json(
      { ok: false, error: { code: "forbidden", message: "Not allowed to download this report." } },
      { status: 403 }
    );
  }

  const { searchParams } = new URL(request.url);
  const assumptions = parseAssumptions(searchParams);
  const { rows } = await computeReplenishmentRows(supabase, assumptions);

  const filtered = filterRows(rows, {
    q: searchParams.get("q") ?? "",
    store: searchParams.get("store") ?? "",
    priority: searchParams.get("priority") ?? "",
    action: searchParams.get("action") ?? "",
  });
  filtered.sort((a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority) || b.score - a.score);

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
    "Size Breakdown (critical rows, 30d sales)",
  ];
  const dataRows = filtered.map((r) => [
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
    r.sizeBreakdown.map((s) => `${s.size}: SOH ${fmt(s.soh)} / 30D ${fmt(s.sales30d)}`).join("; "),
  ]);

  const sheet = XLSX.utils.aoa_to_sheet([header, ...dataRows]);
  sheet["!cols"] = [
    { wch: 10 }, // Priority
    { wch: 8 }, // Score
    { wch: 14 }, // Style No.
    { wch: 14 }, // Color
    { wch: 18 }, // Store
    { wch: 8 }, // SOH
    { wch: 12 }, // Daily Demand
    { wch: 10 }, // Sales 30D
    { wch: 13 }, // Trend
    { wch: 12 }, // Cover
    { wch: 12 }, // Reorder Point
    { wch: 12 }, // Target Stock
    { wch: 16 }, // Recommended Qty
    { wch: 18 }, // Warehouse Available
    { wch: 30 }, // Source
    { wch: 22 }, // Action
    { wch: 70 }, // Why
    { wch: 50 }, // Size Breakdown
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Replenishment");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="replenishment-${stamp}.xlsx"`,
    },
  });
}
