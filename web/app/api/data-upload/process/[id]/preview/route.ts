import { NextResponse } from "next/server";
import { createClient as createDataClient } from "@/lib/data/client";
import { getObjectBuffer } from "@/lib/storage/supabase";
import { parseSaleWorkbook } from "@/lib/erpReports/parseSaleWorkbook";
import { parseStockWorkbook } from "@/lib/erpReports/parseStockWorkbook";
import { parseSchemeWorkbook } from "@/lib/erpReports/parseSchemeWorkbook";
import { parseMasterWorkbook } from "@/lib/erpReports/parseMasterWorkbook";
import { parseChannelSummaryWorkbook } from "@/lib/erpReports/parseChannelSummaryWorkbook";

// See api/data-upload/upload/route.ts's note on this — downloading +
// parsing a large workbook can plausibly exceed Vercel's default function
// duration ceiling. 60 is the Hobby-plan ceiling itself.
export const maxDuration = 60;

type UploadRow = {
  report_type: "sale" | "stock" | "scheme" | "master" | "channel_summary";
  storage_path: string;
  file_name: string;
};

/**
 * Step 2 of validate -> preview -> commit (see migration 0024's header).
 * Downloads the already-uploaded file from MinIO, parses it with the
 * matching parser, and reports what committing WOULD do — no writes here.
 * Access control: relies entirely on RLS on ops.erp_report_uploads
 * (ho_admin/super_admin only, migration 0022) — a caller without that role
 * gets an empty select here, which reads as "not found" below, same
 * deliberate non-disclosure as the existing download route.
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

  try {
    if (upload.report_type === "sale") {
      // Multi-sheet, financial-year-wise workbooks (2026-08-25) — see
      // parseSaleWorkbook's own header for why this can be more than one
      // sheet. skippedSheets surfaces any sheet that didn't look like a
      // data sheet (e.g. a cover tab) so a real mismatch isn't silently
      // invisible, same spirit as row-level sampleErrors below.
      const { rows, sheetNames, skippedSheets } = parseSaleWorkbook(arrayBuffer);
      const errorRows = rows.filter((r) => r.error);
      return NextResponse.json({
        ok: true,
        data: {
          reportType: "sale",
          sheetName: sheetNames.join(", "),
          skippedSheets,
          totalRows: rows.length,
          validRows: rows.length - errorRows.length,
          errorRows: errorRows.length,
          sampleErrors: errorRows.slice(0, 20).map((r) => ({ rowNumber: r.rowNumber, error: r.error })),
          sample: rows.slice(0, 5),
        },
      });
    }

    if (upload.report_type === "stock") {
      const { rows, sheetName } = parseStockWorkbook(arrayBuffer);
      const errorRows = rows.filter((r) => r.error);
      const totalClosingStock = rows.filter((r) => !r.error).reduce((sum, r) => sum + r.closingStock, 0);
      return NextResponse.json({
        ok: true,
        data: {
          reportType: "stock",
          sheetName,
          totalRows: rows.length,
          validRows: rows.length - errorRows.length,
          errorRows: errorRows.length,
          totalClosingStock,
          sampleErrors: errorRows.slice(0, 20).map((r) => ({ rowNumber: r.rowNumber, error: r.error })),
          sample: rows.slice(0, 5),
        },
      });
    }

    if (upload.report_type === "master") {
      // Master files vary in shape, so the preview carries two extra things
      // the other three don't need: the resolved header mapping (which of
      // YOUR columns became which field) and how many duplicate item codes
      // collapsed. Row-level "errors" here are only ever blank item codes,
      // reported in the same {rowNumber, error} shape the UI already renders.
      const { rows, sheetName, headerMapping, headersFound, totalRowsRead, duplicatesCollapsed, skipped } =
        parseMasterWorkbook(arrayBuffer);
      return NextResponse.json({
        ok: true,
        data: {
          reportType: "master",
          sheetName,
          totalRows: totalRowsRead,
          validRows: rows.length,
          errorRows: skipped.length,
          duplicatesCollapsed,
          headerMapping,
          headersFound,
          sampleErrors: skipped.slice(0, 20).map((s) => ({ rowNumber: s.rowNumber, error: s.reason })),
          sample: rows.slice(0, 5),
        },
      });
    }

    if (upload.report_type === "channel_summary") {
      // "Sale Summary" — wholesale/distribution-channel sales (0101). Fixed
      // header (unlike master), so no header-mapping table to show, but the
      // header row's POSITION varies (the profiled sample has a leading
      // blank row) — surfacing which row the parser actually found it on is
      // the one extra thing worth showing here, same spirit as master's
      // headerMapping: make the one genuinely-variable thing visible before
      // committing.
      const { rows, sheetName } = parseChannelSummaryWorkbook(arrayBuffer);
      const errorRows = rows.filter((r) => r.error);
      const activeChannels = new Set(rows.filter((r) => !r.error).map((r) => r.channelName)).size;
      return NextResponse.json({
        ok: true,
        data: {
          reportType: "channel_summary",
          sheetName,
          totalRows: rows.length,
          validRows: rows.length - errorRows.length,
          errorRows: errorRows.length,
          activeChannels,
          sampleErrors: errorRows.slice(0, 20).map((r) => ({ rowNumber: r.rowNumber, error: r.error })),
          sample: rows.slice(0, 5),
        },
      });
    }

    // scheme
    const { rows, sheetName } = parseSchemeWorkbook(arrayBuffer);
    const errorRows = rows.filter((r) => r.error);
    const withScheme = rows.filter((r) => !r.error && r.schemeName).length;
    return NextResponse.json({
      ok: true,
      data: {
        reportType: "scheme",
        sheetName,
        totalRows: rows.length,
        validRows: rows.length - errorRows.length,
        errorRows: errorRows.length,
        withScheme,
        sampleErrors: errorRows.slice(0, 20).map((r) => ({ rowNumber: r.rowNumber, error: r.error })),
        sample: rows.slice(0, 5),
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "unreadable_file",
          message: err instanceof Error ? err.message : "Couldn't read that file as an Excel workbook.",
        },
      },
      { status: 400 }
    );
  }
}
