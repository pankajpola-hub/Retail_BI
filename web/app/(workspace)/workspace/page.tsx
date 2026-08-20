import { requirePageAccess, PAGE_ROLE_DEFAULTS } from "@/lib/auth/roles";
import { createClient } from "@/lib/data/client";
import {
  getOrCreateDefaultWorkspace,
  getWorkspaceById,
  listMyWorkspaces,
  listSharedWithMe,
} from "@/lib/workspace/actions";
import { fetchSalesComponentData, SALES_COMPONENT_RENDERERS, PLANNED_METRIC_IDS } from "@/lib/workspace/renderSalesComponents";
import { fetchStockComponentData, STOCK_COMPONENT_RENDERERS } from "@/lib/workspace/renderStockComponents";
import { fetchMixComponentData, MIX_COMPONENT_RENDERERS } from "@/lib/workspace/renderMixComponents";
import { fetchReplenishmentComponentData, REPLENISHMENT_COMPONENT_RENDERERS } from "@/lib/workspace/renderReplenishmentComponents";
import { fetchFootfallComponentData, FOOTFALL_COMPONENT_RENDERERS } from "@/lib/workspace/renderFootfallComponents";
import { fetchTargetsComponentData, TARGETS_COMPONENT_RENDERERS } from "@/lib/workspace/renderTargetsComponents";
import { listMetricDefinitionsByIds, listDimensionDefinitions } from "@/lib/workspace/semantic";
import { WorkspaceGridClient, type GridItemMeta } from "./WorkspaceGridClient";
import { AddComponentPicker, type PickableComponent } from "./AddComponentPicker";
import { WorkspaceFiltersBar } from "./WorkspaceFiltersBar";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { LazyMount } from "./LazyMount";
import { ChartSkeleton } from "@/components/ui/Skeleton";

export const dynamic = "force-dynamic";

type StoreRow = { store_id: string; store_name: string };
type ComponentDefRow = {
  id: string;
  name: string;
  description: string;
  default_w: number;
  default_h: number;
  cost: "low" | "medium" | "high";
  category: string;
  requires_page_key: string;
};

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export default async function WorkspacePage({
  searchParams,
}: {
  searchParams: { workspaceId?: string };
}) {
  // Independent re-check of the layout's requirePageAccess — same
  // reasoning as (stock-details)/page.tsx: cheap (React cache()-memoized
  // per request) and keeps this page correct if it's ever reached from
  // somewhere other than this route group's own layout.
  const user = await requirePageAccess("workspace");

  const supabase = await createClient();

  // 2026-08-15 — workspace list/switcher. ?workspaceId= picks a specific
  // workspace (own or shared, RLS decides); absent, or an id the caller
  // can't read, falls back to the default exactly as before this feature
  // existed, so nothing changes for anyone who never touches it.
  const [{ data: storesData }, requestedSnapshot, myWorkspaces, sharedWithMe] = await Promise.all([
    supabase.schema("core").from<StoreRow>("stores").select("store_id, store_name").order("store_id"),
    searchParams.workspaceId ? getWorkspaceById(searchParams.workspaceId) : Promise.resolve(null),
    listMyWorkspaces(),
    listSharedWithMe(),
  ]);
  const snapshot = requestedSnapshot ?? (await getOrCreateDefaultWorkspace());
  const storeList = (storesData ?? []).filter((s) => s.store_id !== "BO-004");
  const storeNames = new Map(storeList.map((s) => [s.store_id, s.store_name]));

  const { workspace, components, filters } = snapshot;

  const dateFilter = filters.find((f) => f.dimension_id === "date");
  const storeFilter = filters.find((f) => f.dimension_id === "store");

  const today = new Date();
  const defaultFrom = new Date(today);
  defaultFrom.setDate(defaultFrom.getDate() - 27);
  const from = dateFilter?.values[0] ?? isoDate(defaultFrom);
  const to = dateFilter?.values[1] ?? isoDate(today);
  const storeIds = storeFilter?.values ?? [];

  // Phase 6: every saved filter that isn't the store/date scope handled above
  // is a governed dimension filter, resolved by the query planner against
  // whichever view each component reads. Empty value lists are dropped here
  // rather than sent as a no-op predicate.
  const dimensionFilters = filters
    .filter((f) => f.dimension_id !== "store" && f.dimension_id !== "date" && f.values.length > 0)
    .map((f) => ({ dimensionId: f.dimension_id, values: f.values }));

  const weeklyStart = new Date(from);
  weeklyStart.setDate(weeklyStart.getDate() - 7);

  // 2026-08-15/20 — every registered component now has a renderer. See
  // Objective.md's dated entries for how each family was built (which
  // functions are shared with their source pages, and what's deliberately
  // scoped down — e.g. capacity_editor/fresh_discounted_tracker need an
  // exactly-one-store selection and say so rather than guessing).
  const ALL_RENDERERS: Record<string, unknown> = {
    ...SALES_COMPONENT_RENDERERS,
    ...STOCK_COMPONENT_RENDERERS,
    ...MIX_COMPONENT_RENDERERS,
    ...REPLENISHMENT_COMPONENT_RENDERERS,
    ...FOOTFALL_COMPONENT_RENDERERS,
    ...TARGETS_COMPONENT_RENDERERS,
  };
  const wiredIds = Object.keys(ALL_RENDERERS);
  const [{ data: registryRows }, plannedMetrics, allDimensions] = await Promise.all([
    supabase
      .schema("workspace")
      .from<ComponentDefRow>("component_definitions")
      .select("id, name, description, default_w, default_h, cost, category, requires_page_key")
      .in("id", wiredIds),
    // Read here rather than inside renderSalesComponents so the semantic-layer
    // lookup shares this round trip instead of adding one — see
    // SalesComponentScope.metricsById.
    listMetricDefinitionsByIds(supabase, [...PLANNED_METRIC_IDS]),
    // Whole dimension catalogue: it is 11 rows of static text (0048), so
    // fetching all of them costs less than deciding which subset is needed.
    listDimensionDefinitions(supabase),
  ]);
  const registryById = new Map((registryRows ?? []).map((r) => [r.id, r]));
  const metricsById = new Map(plannedMetrics.map((m) => [m.id, m]));
  const dimensionsById = new Map(allDimensions.map((d) => [d.id, d]));

  // Role-gated offering — a UX convenience matching requirePageAccess's own
  // role-default data (PAGE_ROLE_DEFAULTS), NOT a second security boundary;
  // the underlying views' RLS is what actually protects the data regardless
  // of what this picker offers, same posture as every other role check in
  // this app (see lib/auth/roles.ts's own header comment).
  const availableIds = wiredIds.filter((id) => {
    const pageKey = registryById.get(id)?.requires_page_key;
    if (!pageKey) return true;
    const defaults = (PAGE_ROLE_DEFAULTS as Record<string, readonly string[]>)[pageKey];
    return !defaults || defaults.includes(user.role);
  });

  // Adding the same component twice is allowed — nothing about the model
  // requires uniqueness, and a user might reasonably want two Store League
  // tables scoped differently once per-component config exists.
  const available: PickableComponent[] = availableIds.map((id) => {
    const def = registryById.get(id);
    return {
      id,
      name: def?.name ?? id,
      description: def?.description ?? "",
      defaultW: def?.default_w ?? 6,
      defaultH: Math.max(2, Math.round((def?.default_h ?? 4) / 1.5)),
      category: def?.category ?? "sales",
    };
  });

  // Each expensive family's fetch only runs if a component of that family is
  // actually present — an empty or single-family workspace pays nothing
  // extra for the others.
  const needsSalesData = components.some((c) => c.component_id in SALES_COMPONENT_RENDERERS);
  const needsStockData = components.some((c) => c.component_id in STOCK_COMPONENT_RENDERERS);
  const needsMixData = components.some((c) => c.component_id in MIX_COMPONENT_RENDERERS);
  const needsReplenishmentData = components.some((c) => c.component_id in REPLENISHMENT_COMPONENT_RENDERERS);
  const needsFootfallData = components.some((c) => c.component_id in FOOTFALL_COMPONENT_RENDERERS);
  const needsTargetsData = components.some((c) => c.component_id in TARGETS_COMPONENT_RENDERERS);

  const [salesData, stockData, mixData, replenishmentData, footfallData, targetsData] = await Promise.all([
    needsSalesData
      ? fetchSalesComponentData(
          { supabase, storeIds, from, to, weeklyStart: isoDate(weeklyStart), metricsById, dimensionsById, dimensionFilters },
          storeNames
        )
      : Promise.resolve(null),
    needsStockData
      ? fetchStockComponentData({ supabase, storeIds, canEditCapacity: user.role === "ho_admin" || user.role === "super_admin" })
      : Promise.resolve(null),
    needsMixData ? fetchMixComponentData({ supabase, storeIds }) : Promise.resolve(null),
    needsReplenishmentData ? fetchReplenishmentComponentData({ supabase }) : Promise.resolve(null),
    needsFootfallData ? fetchFootfallComponentData({ supabase, storeIds, from, to, storeNames }) : Promise.resolve(null),
    needsTargetsData ? fetchTargetsComponentData({ supabase, storeIds }) : Promise.resolve(null),
  ]);

  const gridItems: GridItemMeta[] = components.map((c) => ({
    id: c.id,
    componentName: registryById.get(c.component_id)?.name ?? c.component_id,
    x: c.grid_x,
    y: c.grid_y,
    w: c.grid_w,
    h: c.grid_h,
    cost: registryById.get(c.component_id)?.cost ?? "low",
  }));

  // Each card's content is wrapped in LazyMount so it doesn't actually
  // mount (layout/paint) until scrolled near-into-view, matching the
  // "a 25-component workspace stays usable" goal. Data for every added
  // component is still fetched eagerly above — see LazyMount's own header
  // comment for why that's a stated follow-up, not silently claimed done.
  const renderedChildren = components.map((c) => {
    if (c.component_id in SALES_COMPONENT_RENDERERS && salesData) {
      const Renderer = SALES_COMPONENT_RENDERERS[c.component_id]!;
      return (
        <LazyMount key={c.id} fallback={<ChartSkeleton height={140} />}>
          <Renderer data={salesData} />
        </LazyMount>
      );
    }
    if (c.component_id in STOCK_COMPONENT_RENDERERS && stockData) {
      const Renderer = STOCK_COMPONENT_RENDERERS[c.component_id]!;
      return (
        <LazyMount key={c.id} fallback={<ChartSkeleton height={140} />}>
          <Renderer data={stockData} storeIds={storeIds} />
        </LazyMount>
      );
    }
    if (c.component_id in MIX_COMPONENT_RENDERERS && mixData) {
      const Renderer = MIX_COMPONENT_RENDERERS[c.component_id]!;
      return (
        <LazyMount key={c.id} fallback={<ChartSkeleton height={140} />}>
          <Renderer data={mixData} storeIds={storeIds} />
        </LazyMount>
      );
    }
    if (c.component_id in REPLENISHMENT_COMPONENT_RENDERERS && replenishmentData) {
      const Renderer = REPLENISHMENT_COMPONENT_RENDERERS[c.component_id]!;
      return (
        <LazyMount key={c.id} fallback={<ChartSkeleton height={140} />}>
          <Renderer data={replenishmentData} />
        </LazyMount>
      );
    }
    if (c.component_id in FOOTFALL_COMPONENT_RENDERERS && footfallData) {
      const Renderer = FOOTFALL_COMPONENT_RENDERERS[c.component_id]!;
      return (
        <LazyMount key={c.id} fallback={<ChartSkeleton height={140} />}>
          <Renderer data={footfallData} />
        </LazyMount>
      );
    }
    if (c.component_id in TARGETS_COMPONENT_RENDERERS && targetsData) {
      const Renderer = TARGETS_COMPONENT_RENDERERS[c.component_id]!;
      return (
        <LazyMount key={c.id} fallback={<ChartSkeleton height={140} />}>
          <Renderer data={targetsData} />
        </LazyMount>
      );
    }
    return (
      <p key={c.id} className="text-sm text-ink-3">
        &ldquo;{c.component_id}&rdquo; isn&apos;t wired to live rendering yet — catalogued in the registry, not
        available in the workspace builder this phase.
      </p>
    );
  });

  const nextY = components.length > 0 ? Math.max(...components.map((c) => c.grid_y + c.grid_h)) : 0;

  const scopeLabel =
    storeIds.length === 0
      ? "All stores"
      : storeIds.length === 1
        ? storeNames.get(storeIds[0]!) ?? storeIds[0]
        : `${storeIds.length} stores`;

  return (
    <main className="py-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line-soft pb-4">
        <div>
          <WorkspaceSwitcher
            current={{ id: workspace.id, name: workspace.name, isDefault: workspace.is_default }}
            myWorkspaces={myWorkspaces}
            sharedWithMe={sharedWithMe}
          />
          <p className="mt-1 text-[12.5px] text-ink-3">
            {components.length} component{components.length === 1 ? "" : "s"} · {scopeLabel} · {from} → {to}
          </p>
        </div>
        <p className="max-w-xs text-right text-[11.5px] leading-snug text-ink-3">
          Visible only to you unless shared. Drag a card&apos;s header to move it, its corner to resize.
        </p>
      </div>

      <div className="mt-4">
        <WorkspaceFiltersBar
          workspaceId={workspace.id}
          stores={storeList}
          initialStoreIds={storeIds}
          initialFrom={from}
          initialTo={to}
        />
      </div>

      <div className="mt-5">
        <WorkspaceGridClient
          workspaceId={workspace.id}
          items={gridItems}
          toolbarExtra={<AddComponentPicker workspaceId={workspace.id} available={available} nextY={nextY} />}
        >
          {renderedChildren}
        </WorkspaceGridClient>
      </div>
    </main>
  );
}
