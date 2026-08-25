import { NextResponse } from "next/server";
import { createClient as createDataClient } from "@/lib/data/client";
import { getObjectBuffer } from "@/lib/storage/supabase";
import { parseSaleWorkbook } from "@/lib/erpReports/parseSaleWorkbook";
import { parseStockWorkbook } from "@/lib/erpReports/parseStockWorkbook";
import { parseSchemeWorkbook } from "@/lib/erpReports/parseSchemeWorkbook";
import { parseMasterWorkbook } from "@/lib/erpReports/parseMasterWorkbook";
import { cleanupOlderUploads } from "@/lib/erpReports/retention";

type UploadRow = {
  report_type: "sale" | "stock" | "scheme" | "master";
  storage_path: string;
  file_name: string; // recorded as raw_logic.item_master.source_file on a master commit
};

/**
 * Step 3 of validate -> preview -> commit (migration 0024). Re-parses the
 * same file (never trusts a client-supplied row set) and hands the VALID
 * rows to the matching SECURITY DEFINER function, which does the actual
 * raw_logic write and marks the upload 'processed'. Rows that failed
 * validation are skipped and reported back, not silently dropped.
 *
 * If the RPC call throws (e.g. the role check inside it fails for a caller
 * who isn't ho_admin/super_admin, or a genuine write error), the whole
 * function's transaction rolls back — including its own status='processed'
 * update — so this route marks the upload 'failed' with the error message
 * as a separate statement afterward.
 */
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const supabase = await createDataClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: { code: "unauthorized", message: "Not signed in." } }, { status: 401 });
  }

  const { data: upload } = await supabase
    .schema("ops")
    .from<UploadRow>("erp_report_uploads")
    .select("report_type, storage_path, file_name")
    .eq("id", params.id)
    .maybeSingle();

  if (!upload) {
    return NextResponse.json({ ok: false, error: { code: "not_found", message: "Upload not found." } }, { status: 404 });
  }

  let buffer: Buffer;
  try {
    buffer = await getObjectBuffer("erp-reports", upload.storage_path);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: { code: "download_failed", message: err instanceof Error ? err.message : "Couldn't read the file from storage." } },
      { status: 500 }
    );
  }
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;

  async function markFailed(message: string) {
    await supabase
      .schema("ops")
      .from("erp_report_uploads")
      .update({ status: "failed", notes: message.slice(0, 2000) })
      .eq("id", params.id);
  }

  try {
    if (upload.report_type === "sale") {
      const { rows } = parseSaleWorkbook(arrayBuffer);
      const valid = rows.filter((r) => !r.error);
      const payload = valid.map((r) => ({
        branch_name: r.branchName,
        bill_date: r.billDate,
        bill_no: r.billNo,
        item_code: r.itemCode,
        total_quantity: r.totalQuantity,
        gross_amount: r.grossAmount,
        net_amount: r.netAmount,
        agent_name: r.agentName,
        scheme_name: r.schemeName,
        scheme_group_name: r.schemeGroupName,
        bill_time: r.billTime,
        shade_name: r.shadeName,
        pack_size: r.packSize,
        category: r.category,
        subcategory: r.subcategory,
        season: r.season,
        market_segment: r.marketSegment,
        gender: r.gender,
        size_group: r.sizeGroup,
        mrp: r.mrp,
        line_seq: r.lineSeq,
      }));

      const { data, error } = await supabase
        .schema("ops")
        .rpc<number>("fn_process_sale_upload", { p_upload_id: params.id, p_rows: payload });

      if (error) {
        await markFailed(error.message);
        return NextResponse.json({ ok: false, error: { code: "commit_failed", message: error.message } }, { status: 400 });
      }

      return NextResponse.json({
        ok: true,
        data: { reportType: "sale", committedRows: data, skippedRows: rows.length - valid.length },
      });
    }

    if (upload.report_type === "stock") {
      const { rows } = parseStockWorkbook(arrayBuffer);
      const valid = rows.filter((r) => !r.error);
      const payload = valid.map((r) => ({
        branch_name: r.branchName,
        godown_name: r.godownName,
        company_name: r.companyName,
        season: r.season,
        market_segment: r.marketSegment,
        gender: r.gender,
        size_group: r.sizeGroup,
        subcategory: r.subcategory,
        micro_season: r.microSeason,
        pricelist: r.pricelist,
        item_code: r.itemCode,
        additional_item_code: r.additionalItemCode,
        item_name: r.itemName,
        shade_name: r.shadeName,
        size: r.size,
        closing_stock: r.closingStock,
        packing: r.packing,
        rate: r.rate,
      }));

      const { data, error } = await supabase
        .schema("ops")
        .rpc<number>("fn_process_stock_upload", { p_upload_id: params.id, p_rows: payload });

      if (error) {
        await markFailed(error.message);
        return NextResponse.json({ ok: false, error: { code: "commit_failed", message: error.message } }, { status: 400 });
      }

      // Now safe: fn_process_stock_upload already re-pointed
      // raw_logic.stock_snapshot at THIS upload's id, so the old upload
      // row(s) are no longer referenced by anything and can be deleted.
      await cleanupOlderUploads(supabase, "stock", params.id);

      return NextResponse.json({
        ok: true,
        data: { reportType: "stock", committedRows: data, skippedRows: rows.length - valid.length },
      });
    }

    if (upload.report_type === "master") {
      // The parser has already deduplicated by item_code (last one wins) and
      // dropped blank-item-code rows, so every row here is committable.
      const { rows, skipped, duplicatesCollapsed } = parseMasterWorkbook(arrayBuffer);
      const payload = rows.map((r) => ({
        item_code: r.itemCode,
        item_name: r.itemName,
        shade_name: r.shadeName,
        pack_size: r.packSize,
        category: r.category,
        subcategory: r.subcategory,
        season: r.season,
        market_segment: r.marketSegment,
        gender: r.gender,
        size_group: r.sizeGroup,
        size: r.size,
        mrp: r.mrp,
      }));

      // Same door as every other branch: the user-scoped client plus a
      // SECURITY DEFINER function (migration 0054) that does the whole UPSERT
      // in one statement inside its own transaction. Unlike the other three
      // this one returns jsonb, because inserted-vs-updated is the useful
      // signal on a master file.
      const { data, error } = await supabase
        .schema("ops")
        .rpc<{ inserted: number; updated: number; total: number }>("fn_process_master_upload", {
          p_upload_id: params.id,
          p_rows: payload,
          p_source_file: upload.file_name,
        });

      if (error) {
        await markFailed(error.message);
        return NextResponse.json({ ok: false, error: { code: "commit_failed", message: error.message } }, { status: 400 });
      }

      return NextResponse.json({
        ok: true,
        data: {
          reportType: "master",
          committedRows: data?.total ?? 0,
          insertedRows: data?.inserted ?? 0,
          updatedRows: data?.updated ?? 0,
          duplicatesCollapsed,
          skippedRows: skipped.length,
        },
      });
    }

    // scheme
    const { rows } = parseSchemeWorkbook(arrayBuffer);
    const valid = rows.filter((r) => !r.error);
    const payload = valid.map((r) => ({
      item_code: r.itemCode,
      scheme_name: r.schemeName,
      discount_pct: r.discountPct,
      is_discounted_50plus: r.isDiscounted50Plus,
    }));

    const { data, error } = await supabase
      .schema("ops")
      .rpc<number>("fn_process_scheme_upload", { p_upload_id: params.id, p_rows: payload });

    if (error) {
      await markFailed(error.message);
      return NextResponse.json({ ok: false, error: { code: "commit_failed", message: error.message } }, { status: 400 });
    }

    // Now safe — see the "stock" branch above for why this can't run any earlier.
    await cleanupOlderUploads(supabase, "scheme", params.id);

    return NextResponse.json({
      ok: true,
      data: { reportType: "scheme", committedRows: data, skippedRows: rows.length - valid.length },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Couldn't read that file as an Excel workbook.";
    await markFailed(message);
    return NextResponse.json({ ok: false, error: { code: "unreadable_file", message } }, { status: 400 });
  }
}
