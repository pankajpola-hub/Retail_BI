import { createClient } from "@/lib/data/client";
import { requirePageAccess } from "@/lib/auth/roles";
import { StoreFilter, MultiSelectFilter } from "@/components/ui/StoreFilter";
import { MonthlyTargetForm } from "./monthly-target-form";
import { BulkUploadForm } from "./bulk-upload-form";
import { UploadTargetsForm } from "./upload-form";
import { getDict } from "@/lib/i18n/server";
import { RemarkCell } from "./remark-cell";

export const dynamic = "force-dynamic";

type StoreRow = { store_id: string; store_name: string };
type ImportRow = { id: string; file_name: string; uploaded_at: string; status: string };
type RemarkRow = { date: string; bucket: "fresh" | "discounted"; remark_text: string | null };

type TrackerRow = {
  date: string;
  day_name: string;
  day_of_month: number;
  fresh_target_qty: number;
  discounted_target_qty: number;
  fresh_actual_qty: number;
  discounted_actual_qty: number;
  fresh_cum_qty: number;
  discounted_cum_qty: number;
  fresh_mtd_target: number;
  discounted_mtd_target: number;
};

function pct(actual: number, target: number): string {
  if (target <= 0) return "—";
  return `${Math.round((actual / target) * 100)}%`;
}

// Green -> yellow -> red heat map, same idea as the sheet's own conditional
// formatting: how far ahead/behind pace the MTD Deficit% is, at a glance,
// without reading the number. Clamped at +/-40% — beyond that the color
// stops changing, but the number underneath still shows the real value.
function deficitHeat(deficitPct: number): string {
  const clamped = Math.max(-40, Math.min(40, deficitPct));
  const t = (clamped + 40) / 80; // 0 = worst behind, 1 = best ahead
  const hue = t * 120; // 0 = red, 120 = green
  return `hsla(${hue}, 70%, 45%, 0.28)`;
}

function CategoryTracker({
  title,
  bucket,
  monthlyTarget,
  rows,
  targetKey,
  actualKey,
  cumKey,
  mtdTargetKey,
  remarks,
  storeId,
  canWriteRemarks,
}: {
  title: string;
  bucket: "fresh" | "discounted";
  monthlyTarget: number;
  rows: TrackerRow[];
  targetKey: "fresh_target_qty" | "discounted_target_qty";
  actualKey: "fresh_actual_qty" | "discounted_actual_qty";
  cumKey: "fresh_cum_qty" | "discounted_cum_qty";
  mtdTargetKey: "fresh_mtd_target" | "discounted_mtd_target";
  // Remarks column, at the end of each table — Fresh and Discounted each get
  // their own independently-editable remark per day now (0038: separate
  // remarks per bucket, rather than one shared box that only ever rendered
  // on the Fresh table).
  remarks?: Record<string, string>;
  storeId?: string;
  canWriteRemarks?: boolean;
}) {
  const latest = rows.at(-1);
  const cumSoFar = latest?.[cumKey] ?? 0;

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">{title}</span>
        <span className="text-[12px] text-ink-3">
          Target {monthlyTarget} · MTD {cumSoFar} ({pct(cumSoFar, monthlyTarget)})
        </span>
      </div>
      <div className="mt-2 overflow-x-auto border border-line-soft">
        <table className="w-full min-w-[560px] text-[12.5px]">
          <thead>
            <tr className="border-b border-line-soft bg-surface-2 text-left text-[10px] uppercase tracking-wide text-ink-3">
              <th className="px-2 py-2">Date</th>
              <th className="px-2 py-2 text-right">MTD target</th>
              <th className="px-2 py-2 text-right">Actual</th>
              <th className="px-2 py-2 text-right">Cumulative</th>
              <th className="px-2 py-2 text-right">Ach%</th>
              <th className="px-2 py-2 text-right">MTD deficit</th>
              {remarks && <th className="px-2 py-2 text-left">Remarks</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const mtdTarget = r[mtdTargetKey];
              const cum = r[cumKey];
              const target = r[targetKey];
              // Same formula as the sheet's own MTD Deficit column: how far
              // ahead/behind pace, expressed as a % of the WHOLE month's
              // target (not a % of the day's target) — so -10% means "10% of
              // the full month behind," directly comparable day to day.
              const deficitPct = target > 0 ? ((cum - mtdTarget) / target) * 100 : 0;
              return (
                <tr key={r.date} className="border-b border-line-soft font-mono tabular-nums last:border-0">
                  <td className="px-2 py-1.5 font-sans">
                    {r.day_of_month} {r.day_name}
                  </td>
                  <td className="px-2 py-1.5 text-right text-ink-3">{mtdTarget}</td>
                  <td className="px-2 py-1.5 text-right">{r[actualKey]}</td>
                  <td className="px-2 py-1.5 text-right">{cum}</td>
                  <td className={`px-2 py-1.5 text-right ${cum >= mtdTarget ? "text-good" : "text-crit"}`}>
                    {pct(cum, target)}
                  </td>
                  <td
                    className="px-2 py-1.5 text-right"
                    style={{ backgroundColor: deficitHeat(deficitPct) }}
                  >
                    {deficitPct >= 0 ? "+" : ""}
                    {deficitPct.toFixed(2)}%
                  </td>
                  {remarks && storeId && (
                    <td className="px-2 py-1.5 font-sans">
                      <RemarkCell
                        storeId={storeId}
                        date={r.date}
                        bucket={bucket}
                        initialText={remarks[r.date] ?? ""}
                        editable={Boolean(canWriteRemarks)}
                      />
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default async function TargetsPage({
  searchParams,
}: {
  searchParams: {
    store?: string;
    month?: string;
    gender?: string;
    category?: string;
  };
}) {
  // requirePageAccess (migration 0035) layers a per-user override on top of
  // the role default — (ho)/layout.tsx's gate is coarse (it also hosts
  // /network, a different page_key), so the "targets" page_key check has to
  // happen here instead.
  //
  // 0032 widened PAGE_ROLE_DEFAULTS.targets to include ebo_manager so store
  // staff can reach this page and write daily Remarks — canSetTargets below
  // (monthly Fresh/Discounted targets, bulk upload) deliberately stays
  // narrower, unchanged from before. canWriteRemarks is the new, wider gate:
  // anyone who can view this page can write a remark for a store they have
  // access to (ops.daily_target_remarks' own RLS is the real backstop that
  // scopes an ebo_manager's writes to their own store, same
  // core.fn_user_store_ids() pattern used everywhere else).
  const user = await requirePageAccess("targets");
  const canSetTargets = user.role === "ho_admin" || user.role === "super_admin";
  const canWriteRemarks = true;
  const supabase = await createClient();
  const t = await getDict();

  const today = new Date().toISOString().slice(0, 10);
  const currentMonth = today.slice(0, 7);

  const { data: stores } = await supabase
    .schema("core")
    .from<StoreRow>("stores")
    .select("store_id, store_name")
    .order("store_id");
  // BO-004 (Phoenix Palassio, Lucknow) is discontinued — kept visible only on
  // /network for historical reference, hidden from every other store filter.
  const storeList = (stores ?? []).filter((s) => s.store_id !== "BO-004");

  const storeId =
    searchParams.store && storeList.some((s) => s.store_id === searchParams.store)
      ? searchParams.store
      : (storeList[0]?.store_id ?? "");
  const month = searchParams.month && /^\d{4}-\d{2}$/.test(searchParams.month) ? searchParams.month : currentMonth;
  const periodMonth = `${month}-01`;

  // Gender/Category filter option lists. Gender comes from the
  // stock-snapshot lookup (0029); Category (0032) comes straight off the
  // sale line itself (sales.vw_sale_category_options, sourced from
  // raw_logic.sales_transactions.category, 0030) — a genuine point-of-sale
  // value, not a stock-snapshot join. Both lists include Accessories too
  // (0037/0039) — whether accessories count toward the Fresh/Discounted
  // totals is entirely up to what the user selects here, the app no longer
  // excludes them automatically. The Subcategory filter that used to sit
  // alongside these was removed per user request; the underlying RPC still
  // accepts p_subcategories (passed null, unfiltered) rather than being
  // re-migrated, since dropping the column would touch the view/function too
  // for no behavioral gain. Both remaining filters are multi-select: the URL
  // param is a comma-separated list; missing = default (see parseMulti
  // below), present-but-empty = explicitly cleared to "no filter".
  const [{ data: genderOptions }, { data: categoryOptions }] = await Promise.all([
    supabase.schema("sales").from<{ gender: string }>("vw_item_gender_options").select("gender"),
    supabase.schema("sales").from<{ category: string }>("vw_sale_category_options").select("category"),
  ]);
  const genderList = (genderOptions ?? []).map((r) => r.gender).filter(Boolean);
  const categoryList = (categoryOptions ?? []).map((r) => r.category).filter(Boolean);

  // No ?gender/?category in the URL at all (first visit, not "user cleared
  // the filter") defaults to Gender: Female / Category: Apparel — the two
  // values HO reviews most often — while still leaving both fully
  // user-editable/clearable via the filter UI itself.
  function parseMulti(raw: string | undefined, valid: string[], defaultValue: string): string[] {
    if (raw === undefined) return valid.includes(defaultValue) ? [defaultValue] : [];
    if (raw === "") return [];
    return raw.split(",").filter((v) => valid.includes(v));
  }
  const genders = parseMulti(searchParams.gender, genderList, "FEMALE");
  const categories = parseMulti(searchParams.category, categoryList, "APPAREL");
  const hasAttributeFilter = genders.length > 0 || categories.length > 0;

  // Every day of the month, not just up to today — a manager reviewing MTD
  // deficit mid-month wants to see how the remaining days pace out, and the
  // window functions inside the function already freeze cumulative totals
  // correctly once actuals run out (future days just contribute 0), so
  // nothing here needs to compensate for showing them.
  //
  // ops.fn_monthly_fresh_disc_tracker (0029) replaces a plain select off
  // ops.vw_monthly_fresh_disc_tracker so Gender/Subcategory can be passed
  // through as filter params (null = unfiltered, byte-for-byte the same
  // output as the view). It still returns one row per day of the month —
  // the filtering happens inside the SQL aggregation, not by pulling every
  // line to this page and summing in JS.
  // trackerRows and imports are independent queries (imports doesn't depend
  // on storeId/month/gender/subcategory at all) — fetched in parallel rather
  // than one after another, same pattern as the gender/subcategory options
  // above.
  // Remarks (0032) — one row per day this store/month has a saved comment.
  // Independent of the tracker RPC (ops.daily_target_remarks isn't joined
  // into ops.fn_monthly_fresh_disc_tracker at all), fetched in the same
  // Promise.all batch. nextMonth computed in JS (not SQL) for an exclusive
  // upper bound, same reasoning as the audit-report route.
  const [yStr, mStr] = month.split("-");
  const nextMonth = new Date(Date.UTC(Number(yStr), Number(mStr), 1)).toISOString().slice(0, 10);

  const [{ data: trackerRows }, { data: imports }, { data: remarkRows }] = await Promise.all([
    storeId
      ? supabase.schema("ops").rpc<TrackerRow[]>("fn_monthly_fresh_disc_tracker", {
          p_store_id: storeId,
          p_period_month: periodMonth,
          p_genders: genders.length > 0 ? genders : null,
          p_subcategories: null,
          p_categories: categories.length > 0 ? categories : null,
        })
      : Promise.resolve({ data: null }),
    supabase
      .schema("ops")
      .from<ImportRow>("incentive_target_imports")
      .select("id, file_name, uploaded_at, status")
      .order("uploaded_at", { ascending: false }),
    storeId
      ? supabase
          .schema("ops")
          .from<RemarkRow>("daily_target_remarks")
          .select("date, bucket, remark_text")
          .eq("store_id", storeId)
          .gte("date", periodMonth)
          .lt("date", nextMonth)
      : Promise.resolve({ data: null }),
  ]);

  const rows = (trackerRows ?? []) as TrackerRow[];
  const monthlyFreshTarget = rows[0]?.fresh_target_qty ?? 0;
  const monthlyDiscTarget = rows[0]?.discounted_target_qty ?? 0;
  const freshRemarksByDate: Record<string, string> = {};
  const discountedRemarksByDate: Record<string, string> = {};
  for (const r of remarkRows ?? []) {
    if (!r.remark_text) continue;
    (r.bucket === "fresh" ? freshRemarksByDate : discountedRemarksByDate)[r.date] = r.remark_text;
  }

  return (
    <main className="py-6">
      <h1 className="font-serif text-2xl">{t.targetsTitle}</h1>
      <p className="mt-1 max-w-2xl text-[12.5px] text-ink-3">{t.targetsSubtitle}</p>

      {canSetTargets && (
        <div className="mt-5 flex flex-col gap-4">
          <MonthlyTargetForm
            key={storeId}
            stores={storeList}
            defaultStoreId={storeId}
            defaultMonth={month}
          />
          <BulkUploadForm />
        </div>
      )}

      <div className="mt-8 flex flex-wrap items-baseline justify-between gap-3">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
          Monthly Fresh / Discounted tracker
        </span>
        <div className="flex flex-wrap items-center gap-3">
          <StoreFilter stores={storeList} selected={storeId} allowAll={false} label="Store" />
          <MultiSelectFilter
            paramName="gender"
            options={genderList}
            selected={genders}
            label="Gender"
            allLabel="All genders"
            clearAsEmptyParam
          />
          <MultiSelectFilter
            paramName="category"
            options={categoryList}
            selected={categories}
            label="Category"
            allLabel="All categories"
            clearAsEmptyParam
          />
          <form className="flex items-center gap-2 text-[12px] text-ink-3">
            <input type="hidden" name="store" value={storeId} />
            <input type="hidden" name="gender" value={genders.join(",")} />
            <input type="hidden" name="category" value={categories.join(",")} />
            <span>Month</span>
            <input
              type="month"
              name="month"
              defaultValue={month}
              className="min-h-[36px] border border-line bg-surface px-2 py-1.5 text-[13px] text-ink-2"
            />
            <button type="submit" className="min-h-[36px] border border-line px-3 py-1.5 text-[13px] text-ink-2">
              Go
            </button>
          </form>
          {storeId && (
            <a
              href={`/api/targets/monthly/audit-report?store=${encodeURIComponent(storeId)}&month=${encodeURIComponent(month)}${
                genders.length > 0 ? `&gender=${encodeURIComponent(genders.join(","))}` : ""
              }${categories.length > 0 ? `&category=${encodeURIComponent(categories.join(","))}` : ""}`}
              className="min-h-[36px] border border-line px-3 py-1.5 text-[13px] text-ink-2 hover:bg-surface-2"
            >
              Download audit report
            </a>
          )}
        </div>
      </div>

      {hasAttributeFilter && (
        <p className="mt-2 max-w-2xl text-[11.5px] text-ink-3">
          Filtered by {genders.length > 0 && <strong>Gender: {genders.join(", ")}</strong>}
          {genders.length > 0 && categories.length > 0 && " · "}
          {categories.length > 0 && <strong>Category: {categories.join(", ")}</strong>}. Actuals, cumulative and MTD
          deficit% below only count sales matching the filter. The monthly target itself is <strong>not</strong>{" "}
          filtered — targets are only ever entered as one whole-month number per store (no gender/category
          breakdown exists in the data), so Ach% here compares a filtered actual against the full-month target,
          not a sub-target.
        </p>
      )}

      {rows.length === 0 ? (
        <div className="mt-2 border border-line-soft bg-surface-2 p-6 text-center">
          <p className="text-sm text-ink-3">
            No targets set for{" "}
            {new Date(`${month}-01T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" })}{" "}
            at this store yet.
            {!canSetTargets && " Ask an HO Admin / Super Admin to set them."}
          </p>
        </div>
      ) : (
        // Side by side on wide screens, like the sheet's own layout — the
        // two tables are read together (is Discounted picking up slack
        // Fresh is losing this week?), so keeping them stacked vertically
        // made that comparison require scrolling back and forth. Stacks on
        // narrow screens since two 560px-min tables can't fit side by side
        // there anyway.
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-10">
          <div className="lg:flex-1">
            <CategoryTracker
              title="Fresh"
              bucket="fresh"
              monthlyTarget={monthlyFreshTarget}
              rows={rows}
              targetKey="fresh_target_qty"
              actualKey="fresh_actual_qty"
              cumKey="fresh_cum_qty"
              mtdTargetKey="fresh_mtd_target"
              remarks={freshRemarksByDate}
              storeId={storeId}
              canWriteRemarks={canWriteRemarks}
            />
          </div>
          <div className="lg:flex-1">
            <CategoryTracker
              title="Discounted"
              bucket="discounted"
              monthlyTarget={monthlyDiscTarget}
              rows={rows}
              targetKey="discounted_target_qty"
              actualKey="discounted_actual_qty"
              cumKey="discounted_cum_qty"
              mtdTargetKey="discounted_mtd_target"
              remarks={discountedRemarksByDate}
              storeId={storeId}
              canWriteRemarks={canWriteRemarks}
            />
          </div>
        </div>
      )}

      <h2 className="mt-10 text-[11px] font-semibold uppercase tracking-wide text-ink-3">{t.incentiveTargetsTitle}</h2>
      <p className="mt-1 max-w-2xl text-[12.5px] text-ink-3">{t.incentiveTargetsSubtitle}</p>

      <div className="mt-5">
        <UploadTargetsForm />
      </div>

      <h3 className="mt-8 text-[11px] font-semibold uppercase tracking-wide text-ink-3">{t.uploadedFilesTitle}</h3>
      <ul className="mt-2 divide-y divide-line-soft border border-line-soft">
        {imports?.map((i) => (
          <li key={i.id} className="flex items-center justify-between px-3 py-2 text-sm">
            <span>{i.file_name}</span>
            <span className="flex items-center gap-3 text-ink-3">
              <span className="text-[12px]">
                {new Date(i.uploaded_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
              </span>
              <span className="font-mono text-[11px] uppercase tracking-wide">{i.status}</span>
            </span>
          </li>
        )) ?? <li className="px-3 py-2 text-sm text-ink-3">{t.noFilesUploadedYet}</li>}
      </ul>
    </main>
  );
}
