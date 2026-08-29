import { NextResponse } from "next/server";
import { cronAuthFailure } from "@/lib/cron/auth";
import { createAdminClient } from "@/lib/data/admin";
import { getSaleOrderTaxDetail, uniwareRestEnabled } from "@/lib/uniware/client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Enriches ops.recon_lines with the GST breakdown + packet-id presence the SOAP
// feed can't provide, by calling the REST saleorder/get endpoint per order.
//
// UNVERIFIED against live Uniware — the (display_order_code -> internal code)
// mapping and the REST response field names (totalCentralGst etc.) are taken
// from Unicommerce docs, not yet confirmed against this tenant. Run once with a
// small cap and check the result before scheduling.
//
// Bounded per invocation (ENRICH_CAP orders) the same way the uniware-sync
// enrichment phase is, so a large backlog can't blow Vercel's function budget —
// whatever's left (cgst still null) is picked up next run.
const ENRICH_CAP = 25;

export async function GET(request: Request) {
  const denied = cronAuthFailure(request);
  if (denied) return denied;

  if (!uniwareRestEnabled()) {
    return NextResponse.json(
      { ok: false, error: { code: "rest_disabled", message: "UNIWARE_REST_USERNAME/PASSWORD not set." } },
      { status: 400 }
    );
  }

  const admin = await createAdminClient();

  // 1. Candidate orders: recon lines still missing tax, mapped to their Uniware
  //    internal code via raw_uniware.sale_orders.
  const { data: pending, error: pendErr } = await admin
    .schema("ops")
    .from("recon_lines")
    .select("order_code, cgst")
    .order("id", { ascending: true })
    .limit(20000);
  if (pendErr) {
    return NextResponse.json({ ok: false, error: { code: "read_failed", message: pendErr.message } }, { status: 500 });
  }

  // Lines still missing tax (cgst null). Their typed client has no .is(), so
  // filter here rather than server-side.
  const pendingRows = (pending ?? []) as { order_code: string | null; cgst: number | null }[];
  const displayCodes = Array.from(
    new Set(
      pendingRows
        .filter((r) => r.cgst == null && r.order_code)
        .map((r) => r.order_code as string)
    )
  ).slice(0, ENRICH_CAP);

  if (displayCodes.length === 0) {
    return NextResponse.json({ ok: true, ordersProcessed: 0, linesUpdated: 0, note: "nothing to enrich" });
  }

  const { data: orderMap, error: mapErr } = await admin
    .schema("raw_uniware")
    .from("sale_orders")
    .select("code, display_order_code")
    .in("display_order_code", displayCodes);
  if (mapErr) {
    return NextResponse.json({ ok: false, error: { code: "map_failed", message: mapErr.message } }, { status: 500 });
  }

  let ordersProcessed = 0;
  let ordersFailed = 0;
  let linesUpdated = 0;

  for (const om of (orderMap ?? []) as { code: string; display_order_code: string }[]) {
    let items;
    try {
      items = await getSaleOrderTaxDetail(om.code);
    } catch {
      ordersFailed++;
      continue;
    }
    ordersProcessed++;

    for (const it of items) {
      if (!it.itemCode) continue;
      const cgst = it.cgst ?? 0;
      const sgst = it.sgst ?? 0;
      const igst = it.igst ?? 0;
      const tax = cgst + sgst + igst;

      // Only classify a NEW tax exception when the line is otherwise clean —
      // never override an arithmetic exception already flagged.
      const patch: Record<string, unknown> = {
        cgst: it.cgst,
        sgst: it.sgst,
        igst: it.igst,
        packet_id_present: it.hasPacket,
      };

      const { data: updated, error: updErr } = await admin
        .schema("ops")
        .from("recon_lines")
        .update(patch)
        .eq("order_code", om.display_order_code)
        .eq("item_code", it.itemCode)
        .eq("status", "CANCELLED")
        .eq("exception_code", "CLEAN")
        .select("id");
      // The cancelled-with-tax upgrade (only for clean cancelled lines with tax)
      if (!updErr && tax > 1 && updated && updated.length > 0) {
        await admin
          .schema("ops")
          .from("recon_lines")
          .update({ exception_code: "CANCELLED_WITH_TAX", exception_severity: "Medium", exception_amount: tax })
          .in("id", (updated as { id: number }[]).map((u) => u.id));
      }

      // Non-cancelled lines: just write the tax/packet fields (no new exception).
      const { data: plain } = await admin
        .schema("ops")
        .from("recon_lines")
        .update({ cgst: it.cgst, sgst: it.sgst, igst: it.igst, packet_id_present: it.hasPacket })
        .eq("order_code", om.display_order_code)
        .eq("item_code", it.itemCode)
        .neq("status", "CANCELLED")
        .select("id");

      linesUpdated += ((updated?.length ?? 0) + (plain?.length ?? 0));
    }
  }

  return NextResponse.json({ ok: true, ordersProcessed, ordersFailed, linesUpdated, cap: ENRICH_CAP });
}
