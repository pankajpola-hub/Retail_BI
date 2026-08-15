import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { createClient } from "@/lib/data/client";

// Any date within the target month works — only the month it falls in is
// used, matching the single-target form (which asks for a month, not a
// day). DD-MM-YYYY because that's the format Indian retail staff read and
// type without a second thought, and it disambiguates from the US MM-DD-YYYY
// reading that a plain "08-01-2026" would invite.
type StoreRow = {
  store_name: string;
};

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: { code: "unauthorized", message: "Not signed in." } }, { status: 401 });
  }

  const { data: stores } = await supabase.schema("core").from<StoreRow>("stores").select("store_name").order("store_id");
  const exampleStore = stores?.[0]?.store_name ?? "Undri";

  const rows = [
    ["Store", "Date (DD-MM-YYYY)", "Fresh target (Units)", "Discounted target (Units)"],
    [exampleStore, "01-08-2026", 90, 441],
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet["!cols"] = [{ wch: 18 }, { wch: 20 }, { wch: 20 }, { wch: 24 }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Targets");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="monthly-targets-template.xlsx"',
    },
  });
}
