import type { DataClient } from "@/lib/data/client";
import { CategoryTracker, type TrackerRow } from "@/app/(ho)/targets/CategoryTracker";

/**
 * Targets-family workspace components (2026-08-20), closing the last
 * unwired registry category. `fresh_discounted_tracker` reuses
 * CategoryTracker.tsx verbatim — the same table `/targets` itself renders —
 * called via the same RPC (`ops.fn_monthly_fresh_disc_tracker`) with that
 * page's own defaults (current month, Gender: Female, Category: Apparel;
 * there's no per-tile filter UI, same "component defaults its own scope"
 * posture as Mix/Replenishment). Read-only: CategoryTracker's `remarks`
 * prop is simply omitted, which already renders it without a Remarks
 * column or any write affordance — not a new mode built for this.
 *
 * Like capacity_editor, this is fundamentally per-store data (one row per
 * day, for ONE store's targets) — a workspace scope of anything other than
 * exactly one store has nothing sensible to show, so the tile says so
 * rather than guessing.
 */
export type TargetsComponentScope = { supabase: DataClient; storeIds: string[] };

export type TargetsComponentData = {
  storeId: string | null;
  monthlyFreshTarget: number;
  monthlyDiscTarget: number;
  rows: TrackerRow[];
  imports: { id: string; file_name: string; uploaded_at: string; status: string }[];
};

export async function fetchTargetsComponentData(scope: TargetsComponentScope): Promise<TargetsComponentData> {
  const { supabase, storeIds } = scope;
  const storeId = storeIds.length === 1 ? storeIds[0]! : null;

  const today = new Date();
  const periodMonth = `${today.toISOString().slice(0, 7)}-01`;

  const [{ data: trackerRows }, { data: imports }] = await Promise.all([
    storeId
      ? supabase.schema("ops").rpc<TrackerRow[]>("fn_monthly_fresh_disc_tracker", {
          p_store_id: storeId,
          p_period_month: periodMonth,
          p_genders: ["FEMALE"],
          p_subcategories: null,
          p_categories: ["APPAREL"],
        })
      : Promise.resolve({ data: null }),
    supabase
      .schema("ops")
      .from<{ id: string; file_name: string; uploaded_at: string; status: string }>("incentive_target_imports")
      .select("id, file_name, uploaded_at, status")
      .order("uploaded_at", { ascending: false })
      .limit(10),
  ]);

  const rows = (trackerRows ?? []) as TrackerRow[];
  return {
    storeId,
    monthlyFreshTarget: rows[0]?.fresh_target_qty ?? 0,
    monthlyDiscTarget: rows[0]?.discounted_target_qty ?? 0,
    rows,
    imports: imports ?? [],
  };
}

export function FreshDiscountedTracker({ data }: { data: TargetsComponentData }) {
  if (!data.storeId) {
    return (
      <p className="text-sm text-ink-3">
        Select exactly one store in the workspace&apos;s filter to see its Fresh/Discounted tracker. Shown for the
        current month, Gender: Female, Category: Apparel (the page&apos;s own defaults) — not yet configurable per
        tile.
      </p>
    );
  }
  if (data.rows.length === 0) {
    return <p className="text-sm text-ink-3">No targets set for this store this month.</p>;
  }
  return (
    <div className="flex flex-col gap-4 overflow-y-auto lg:flex-row lg:items-start lg:gap-6">
      <div className="lg:flex-1">
        <CategoryTracker
          title="Fresh"
          bucket="fresh"
          monthlyTarget={data.monthlyFreshTarget}
          rows={data.rows}
          targetKey="fresh_target_qty"
          actualKey="fresh_actual_qty"
          cumKey="fresh_cum_qty"
          mtdTargetKey="fresh_mtd_target"
        />
      </div>
      <div className="lg:flex-1">
        <CategoryTracker
          title="Discounted"
          bucket="discounted"
          monthlyTarget={data.monthlyDiscTarget}
          rows={data.rows}
          targetKey="discounted_target_qty"
          actualKey="discounted_actual_qty"
          cumKey="discounted_cum_qty"
          mtdTargetKey="discounted_mtd_target"
        />
      </div>
    </div>
  );
}

export function UploadHistoryList({ data }: { data: TargetsComponentData }) {
  return (
    <ul className="divide-y divide-line-soft border border-line-soft">
      {data.imports.map((i) => (
        <li key={i.id} className="flex items-center justify-between px-3 py-2 text-sm">
          <span>{i.file_name}</span>
          <span className="flex items-center gap-3 text-ink-3">
            <span className="text-[12px]">{new Date(i.uploaded_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</span>
            <span className="font-mono text-[11px] uppercase tracking-wide">{i.status}</span>
          </span>
        </li>
      ))}
      {data.imports.length === 0 && <li className="px-3 py-2 text-sm text-ink-3">No files uploaded yet.</li>}
    </ul>
  );
}

export const TARGETS_COMPONENT_RENDERERS: Record<string, (props: { data: TargetsComponentData }) => JSX.Element> = {
  fresh_discounted_tracker: FreshDiscountedTracker,
  upload_history_list: UploadHistoryList,
};
