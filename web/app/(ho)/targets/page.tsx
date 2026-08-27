import { Suspense } from "react";
import { createClient } from "@/lib/data/client";
import type { DataClient } from "@/lib/data/client";
import { requirePageAccess } from "@/lib/auth/roles";
import { StoreFilter, MultiSelectFilter } from "@/components/ui/StoreFilter";
import { MonthlyTargetForm } from "./monthly-target-form";
import { BulkUploadForm } from "./bulk-upload-form";
import { resolveAccess } from "@/lib/auth/access";
import { UploadTargetsForm } from "./upload-form";
import { getDict } from "@/lib/i18n/server";
import { CategoryTracker, type TrackerRow } from "./CategoryTracker";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { TableSkeleton } from "@/components/ui/Skeleton";
import { SectionErrorBoundary } from "@/components/ui/SectionErrorBoundary";
import { time, timeAll } from "@/lib/perf/timing";

export const dynamic = "force-dynamic";

type StoreRow = { store_id: string; store_name: string; is_active: boolean };
type ImportRow = { id: string; file_name: string; uploaded_at: string; status: string };
type RemarkRow = { date: string; bucket: "fresh" | "discounted"; remark_text: string | null };

// TrackerRow/pct/deficitHeat/CategoryTracker moved to ./CategoryTracker.tsx
// (2026-08-20) so the Workspace's fresh_discounted_tracker component
// renders the identical table this page does — imported above.

function TrackerSkeleton() {
  return (
    <>
      <div className="mt-8 flex flex-wrap items-baseline justify-between gap-3">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
          Monthly Fresh / Discounted tracker
        </span>
      </div>
      <div className="mt-2 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <TableSkeleton rows={6} cols={6} />
        <TableSkeleton rows={6} cols={6} />
      </div>
    </>
  );
}

/**
 * Gender/Category option lists → tracker rows is a genuine sequential
 * dependency (the URL's ?gender/?category values are validated against the
 * fetched option lists before being passed to the RPC — see parseMulti
 * below), so unlike Network/Stock-Details this section keeps ONE internal
 * await-then-await rather than a Promise.all. What it DOES gain from being
 * its own Suspense boundary: it no longer blocks the page shell (title,
 * target-entry forms) or the Uploaded Files section below, which have zero
 * dependency on any of this.
 */
async function TrackerSection({
  supabase,
  storeList,
  storeId,
  month,
  searchParams,
  canSetTargets,
  canWriteRemarks,
  canExportAudit,
}: {
  supabase: DataClient;
  storeList: StoreRow[];
  storeId: string;
  month: string;
  searchParams: { gender?: string; category?: string };
  canSetTargets: boolean;
  canWriteRemarks: boolean;
  canExportAudit: boolean;
}) {
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
  const [{ data: genderOptions }, { data: categoryOptions }] = await timeAll("targets:options", [
    supabase.schema("sales").from<{ gender: string }>("vw_item_gender_options").select("gender"),
    supabase.schema("sales").from<{ category: string }>("vw_sale_category_options").select("category"),
  ] as const);
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
  // Remarks (0032) — one row per day this store/month has a saved comment.
  // Independent of the tracker RPC (ops.daily_target_remarks isn't joined
  // into ops.fn_monthly_fresh_disc_tracker at all), fetched in parallel with
  // it. nextMonth computed in JS (not SQL) for an exclusive upper bound,
  // same reasoning as the audit-report route.
  const [yStr, mStr] = month.split("-");
  const nextMonth = new Date(Date.UTC(Number(yStr), Number(mStr), 1)).toISOString().slice(0, 10);

  const [{ data: trackerRows }, { data: remarkRows }] = await timeAll("targets:tracker", [
    storeId
      ? supabase.schema("ops").rpc<TrackerRow[]>("fn_monthly_fresh_disc_tracker", {
          p_store_id: storeId,
          p_period_month: periodMonth,
          p_genders: genders.length > 0 ? genders : null,
          p_subcategories: null,
          p_categories: categories.length > 0 ? categories : null,
        })
      : Promise.resolve({ data: null }),
    storeId
      ? supabase
          .schema("ops")
          .from<RemarkRow>("daily_target_remarks")
          .select("date, bucket, remark_text")
          .eq("store_id", storeId)
          .gte("date", periodMonth)
          .lt("date", nextMonth)
      : Promise.resolve({ data: null }),
  ] as const);

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
    <>
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
            <Input type="month" name="month" defaultValue={month} className="w-auto" />
            <Button type="submit" variant="outline" size="sm">Go</Button>
          </form>
          {storeId && canExportAudit && (
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
    </>
  );
}

/**
 * Independent of everything above — imports has zero dependency on
 * storeId/month/gender/category, so it was already wasted critical-path
 * time sharing a Promise.all with the tracker query. As its own Suspense
 * boundary it renders as soon as its own single query resolves, regardless
 * of how long the tracker/options chain above takes.
 */
async function UploadedFilesSection({ supabase }: { supabase: DataClient }) {
  const t = await getDict();
  const { data: imports } = await time(
    "targets:imports",
    supabase
      .schema("ops")
      .from<ImportRow>("incentive_target_imports")
      .select("id, file_name, uploaded_at, status")
      .order("uploaded_at", { ascending: false })
  );

  return (
    <>
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
    </>
  );
}

function UploadedFilesSkeleton() {
  return (
    <div className="mt-10">
      <TableSkeleton rows={4} cols={3} />
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

  // 0079: the role-based defaults above are now expressible as permission
  // keys, so an admin can grant or revoke each capability per user without a
  // deploy. The role check is ANDed in rather than replaced — these keys were
  // seeded to every role that can reach the page (0079's behaviour-neutral
  // seed), so dropping the role check would have silently widened
  // target-setting to ebo_manager/regional_manager on apply.
  const access = await resolveAccess();
  const roleCanSetTargets = user.role === "ho_admin" || user.role === "super_admin";
  const canSetTargets = roleCanSetTargets && (access?.can("targets.monthly_targets.edit") ?? true);
  const canBulkUpload = roleCanSetTargets && (access?.can("targets.bulk_upload.edit") ?? true);
  const canIncentiveUpload = roleCanSetTargets && (access?.can("targets.incentive_upload.edit") ?? true);
  const canWriteRemarks = access?.can("targets.remarks.edit") ?? true;
  const canViewTracker = access?.can("targets.tracker.view") ?? true;
  const canExportAudit = access?.can("targets.audit_report.export") ?? true;
  const supabase = await createClient();
  const t = await getDict();

  const today = new Date().toISOString().slice(0, 10);
  const currentMonth = today.slice(0, 7);

  // Small, fast — needed for the header/filter/forms immediately.
  const { data: stores } = await supabase
    .schema("core")
    .from<StoreRow>("stores")
    .select("store_id, store_name, is_active")
    .order("store_id");
  // Inactive stores (core.stores.is_active = false) are kept visible only on
  // /network for historical reference, hidden from every other store filter.
  const storeList = (stores ?? []).filter((s) => s.is_active);

  const storeId =
    searchParams.store && storeList.some((s) => s.store_id === searchParams.store)
      ? searchParams.store
      : (storeList[0]?.store_id ?? "");
  const month = searchParams.month && /^\d{4}-\d{2}$/.test(searchParams.month) ? searchParams.month : currentMonth;

  return (
    <main className="py-6">
      <h1 className="font-serif text-2xl">{t.targetsTitle}</h1>
      <p className="mt-1 max-w-2xl text-[12.5px] text-ink-3">{t.targetsSubtitle}</p>

      {(canSetTargets || canBulkUpload) && (
        <div className="mt-5 flex flex-col gap-4">
          {canSetTargets && (
            <MonthlyTargetForm
              key={storeId}
              stores={storeList}
              defaultStoreId={storeId}
              defaultMonth={month}
            />
          )}
          {canBulkUpload && <BulkUploadForm />}
        </div>
      )}

      {canViewTracker && (
      <SectionErrorBoundary label="Monthly tracker">
        <Suspense fallback={<TrackerSkeleton />}>
          <TrackerSection
            supabase={supabase}
            storeList={storeList}
            storeId={storeId}
            month={month}
            searchParams={searchParams}
            canExportAudit={canExportAudit}
            canSetTargets={canSetTargets}
            canWriteRemarks={canWriteRemarks}
          />
        </Suspense>
      </SectionErrorBoundary>
      )}

      {canIncentiveUpload && (
        <SectionErrorBoundary label="Uploaded files">
          <Suspense fallback={<UploadedFilesSkeleton />}>
            <UploadedFilesSection supabase={supabase} />
          </Suspense>
        </SectionErrorBoundary>
      )}
    </main>
  );
}
