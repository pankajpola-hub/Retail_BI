import { NextResponse } from "next/server";
import { createClient } from "@/lib/data/client";
import { parseMonthlyTargetsWorkbook } from "@/lib/targets/parseMonthlyTargetsWorkbook";

type StoreRow = {
  store_id: string;
  store_name: string;
};

type EboMonthlyTargetRow = {
  store_id: string;
  period_month: string;
  fresh_target_qty: number;
  discounted_target_qty: number;
  updated_at: string;
};

// Step 1 of validate → preview → commit (see 0018 migration's own note on
// this pattern). Parses the file and reports what WOULD happen — no writes
// here. The client shows this as a table for the admin to review, including
// which rows would overwrite an existing target, before /bulk-commit is
// ever called.
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: { code: "unauthorized", message: "Not signed in." } }, { status: 401 });
  }

  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_body", message: "No file uploaded." } },
      { status: 400 }
    );
  }

  const { data: stores } = await supabase.schema("core").from<StoreRow>("stores").select("store_id, store_name");
  const buffer = await file.arrayBuffer();

  let parsed;
  try {
    parsed = parseMonthlyTargetsWorkbook(buffer, stores ?? []);
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "unreadable_file", message: "Couldn't read that file as an Excel workbook." },
      },
      { status: 400 }
    );
  }

  if (parsed.length === 0) {
    return NextResponse.json(
      { ok: false, error: { code: "empty_file", message: "No data rows found below the header." } },
      { status: 400 }
    );
  }

  // Look up existing targets for every valid (store, month) pair in one
  // query, so the preview can flag overwrites without one query per row.
  const validKeys = parsed.filter((r) => r.storeId && r.month);
  let existingByKey = new Map<string, { fresh_target_qty: number; discounted_target_qty: number; updated_at: string }>();
  if (validKeys.length > 0) {
    const storeIds = [...new Set(validKeys.map((r) => r.storeId as string))];
    const periodMonths = [...new Set(validKeys.map((r) => `${r.month}-01`))];
    const { data: existing } = await supabase
      .schema("ops")
      .from<EboMonthlyTargetRow>("ebo_monthly_targets")
      .select("store_id, period_month, fresh_target_qty, discounted_target_qty, updated_at")
      .in("store_id", storeIds)
      .in("period_month", periodMonths);
    existingByKey = new Map(
      (existing ?? []).map((e) => [
        `${e.store_id}|${e.period_month}`,
        { fresh_target_qty: e.fresh_target_qty, discounted_target_qty: e.discounted_target_qty, updated_at: e.updated_at },
      ])
    );
  }

  const rows = parsed.map((r) => {
    const key = r.storeId && r.month ? `${r.storeId}|${r.month}-01` : null;
    const existing = key ? existingByKey.get(key) ?? null : null;
    return { ...r, existing };
  });

  return NextResponse.json({ ok: true, data: { rows } });
}
