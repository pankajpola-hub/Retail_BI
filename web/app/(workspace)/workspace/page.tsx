import { Suspense } from "react";
import { requirePageAccess, PAGE_ROLE_DEFAULTS } from "@/lib/auth/roles";
import { createClient } from "@/lib/data/client";
import {
  getOrCreateDefaultWorkspace,
  getWorkspaceById,
  listMyWorkspaces,
  listSharedWithMe,
} from "@/lib/workspace/actions";
import {
  fetchSalesComponentData,
  SALES_COMPONENT_RENDERERS,
  PLANNED_METRIC_IDS,
  type SalesComponentData,
} from "@/lib/workspace/renderSalesComponents";
import { fetchStockComponentData, STOCK_COMPONENT_RENDERERS, type StockComponentData } from "@/lib/workspace/renderStockComponents";
import { fetchMixComponentData, MIX_COMPONENT_RENDERERS, type MixComponentData } from "@/lib/workspace/renderMixComponents";
import {
  fetchReplenishmentComponentData,
  REPLENISHMENT_COMPONENT_RENDERERS,
  type ReplenishmentComponentData,
} from "@/lib/workspace/renderReplenishmentComponents";
import { fetchFootfallComponentData, FOOTFALL_COMPONENT_RENDERERS } from "@/lib/workspace/renderFootfallComponents";
import type { FootfallInsights } from "@/lib/network/footfall";
import { fetchTargetsComponentData, TARGETS_COMPONENT_RENDERERS, type TargetsComponentData } from "@/lib/workspace/renderTargetsComponents";
import {
  fetchProductAttributeComponentData,
  PRODUCT_ATTRIBUTE_COMPONENT_RENDERERS,
} from "@/lib/workspace/renderProductAttributeComponent";
import type { SaleAttributeLineRow } from "@/lib/sales/attributeBreakdown";
import { listMetricDefinitionsByIds, listDimensionDefinitions } from "@/lib/workspace/semantic";
import { listMyScheduledExports } from "@/lib/exports/actions";
import { WorkspaceGridClient, type GridItemMeta } from "./WorkspaceGridClient";
import { AddComponentPicker, type PickableComponent } from "./AddComponentPicker";
import { WorkspaceFiltersBar } from "./WorkspaceFiltersBar";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { ScheduledExportsPanel } from "./ScheduledExportsPanel";
import { LazyMount } from "./LazyMount";
import { ChartSkeleton } from "@/components/ui/Skeleton";
import { SectionErrorBoundary } from "@/components/ui/SectionErrorBoundary";

export const dynamic = "force-dynamic";

type StoreRow = { store_id: string; store_name: string; is_active: boolean };
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

/**
 * One tiny async server component per family, each `await`ing the SAME
 * shared promise a sibling item of the same family also awaits (see the
 * `*DataPromise` values above) — this is what gives every grid item its own
 * Suspense boundary and its own SectionErrorBoundary (parity item 6) without
 * re-running the family's query once per item. If `componentId` isn't a
 * known renderer for this family (shouldn't happen — callers only reach
 * these from inside an `in SALES_COMPONENT_RENDERERS` etc. check) this
 * renders nothing rather than throwing.
 */
async function SalesFamilyItem({ dataPromise, componentId }: { dataPromise: Promise<SalesComponentData>; componentId: string }) {
  const data = await dataPromise;
  const Renderer = SALES_COMPONENT_RENDERERS[componentId];
  return Renderer ? <Renderer data={data} /> : null;
}

async function StockFamilyItem({
  dataPromise,
  componentId,
  storeIds,
}: {
  dataPromise: Promise<StockComponentData>;
  componentId: string;
  storeIds: string[];
}) {
  const data = await dataPromise;
  const Renderer = STOCK_COMPONENT_RENDERERS[componentId];
  return Renderer ? <Renderer data={data} storeIds={storeIds} /> : null;
}

async function MixFamilyItem({
  dataPromise,
  componentId,
  storeIds,
}: {
  dataPromise: Promise<MixComponentData>;
  componentId: string;
  storeIds: string[];
}) {
  const data = await dataPromise;
  const Renderer = MIX_COMPONENT_RENDERERS[componentId];
  return Renderer ? <Renderer data={data} storeIds={storeIds} /> : null;
}

async function ReplenishmentFamilyItem({ dataPromise, componentId }: { dataPromise: Promise<ReplenishmentComponentData>; componentId: string }) {
  const data = await dataPromise;
  const Renderer = REPLENISHMENT_COMPONENT_RENDERERS[componentId];
  return Renderer ? <Renderer data={data} /> : null;
}

async function FootfallFamilyItem({ dataPromise, componentId }: { dataPromise: Promise<FootfallInsights>; componentId: string }) {
  const data = await dataPromise;
  const Renderer = FOOTFALL_COMPONENT_RENDERERS[componentId];
  return Renderer ? <Renderer data={data} /> : null;
}

async function TargetsFamilyItem({ dataPromise, componentId }: { dataPromise: Promise<TargetsComponentData>; componentId: string }) {
  const data = await dataPromise;
  const Renderer = TARGETS_COMPONENT_RENDERERS[componentId];
  return Renderer ? <Renderer data={data} /> : null;
}

/**
 * D-05 parity item 2 — its own family, deliberately NOT folded into
 * SalesFamilyItem/salesDataPromise above. See
 * lib/workspace/renderProductAttributeComponent.tsx's header for why: this is
 * the only line-grain fetch in the whole Sales set of components, so it gets
 * its own needs.../promise/Suspense boundary below, same "pay only for what's
 * added, and never hold up siblings" pattern StockFamilyItem/MixFamilyItem/etc.
 * already establish for their own families.
 */
async function ProductAttributeFamilyItem({
  dataPromise,
  componentId,
}: {
  dataPromise: Promise<SaleAttributeLineRow[]>;
  componentId: string;
}) {
  const data = await dataPromise;
  const Renderer = PRODUCT_ATTRIBUTE_COMPONENT_RENDERERS[componentId];
  return Renderer ? <Renderer data={data} /> : null;
}

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
  const [{ data: storesData }, requestedSnapshot, myWorkspaces, sharedWithMe, myScheduledExports] = await Promise.all([
    supabase.schema("core").from<StoreRow>("stores").select("store_id, store_name, is_active").order("store_id"),
    searchParams.workspaceId ? getWorkspaceById(searchParams.workspaceId) : Promise.resolve(null),
    listMyWorkspaces(),
    listSharedWithMe(),
    listMyScheduledExports(),
  ]);
  const snapshot = requestedSnapshot ?? (await getOrCreateDefaultWorkspace());
  // Single source of truth for store exclusion is core.stores.is_active —
  // see 0091_bo002_bo004_stores.sql.
  const storeList = (storesData ?? []).filter((s) => s.is_active);
  const storeNames = new Map(storeList.map((s) => [s.store_id, s.store_name]));

  const { workspace, components, filters } = snapshot;

  const dateFilter = filters.find((f) => f.dimension_id === "date");
  const storeFilter = filters.find((f) => f.dimension_id === "store");
  // D-05 parity item 1 — period comparison. Same well-known-dimension_id
  // pattern as store/date (see lib/workspace/actions.ts's updateWorkspaceFilters),
  // not a Phase 6 governed dimension — excluded from dimensionFilters below
  // exactly like store/date already are.
  const compareDateFilter = filters.find((f) => f.dimension_id === "compare_date");

  const today = new Date();
  const defaultFrom = new Date(today);
  defaultFrom.setDate(defaultFrom.getDate() - 27);
  const from = dateFilter?.values[0] ?? isoDate(defaultFrom);
  const to = dateFilter?.values[1] ?? isoDate(today);
  const storeIds = storeFilter?.values ?? [];
  const compareFrom = compareDateFilter?.values[0] ?? null;
  const compareTo = compareDateFilter?.values[1] ?? null;

  // Phase 6: every saved filter that isn't the store/date/compare_date scope
  // handled above is a governed dimension filter, resolved by the query
  // planner against whichever view each component reads. Empty value lists
  // are dropped here rather than sent as a no-op predicate.
  const dimensionFilters = filters
    .filter((f) => f.dimension_id !== "store" && f.dimension_id !== "date" && f.dimension_id !== "compare_date" && f.values.length > 0)
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
    ...PRODUCT_ATTRIBUTE_COMPONENT_RENDERERS,
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
  // D-05 parity item 2 — cost-gated separately from needsSalesData: this is
  // the only line-grain fetch in the family (see
  // renderProductAttributeComponent.tsx's header), so a workspace that never
  // adds product_attribute_table never queries vw_ebo_sale_attribute_lines,
  // and one that does never makes the OTHER Sales tiles wait on it.
  const needsProductAttributeData = components.some((c) => c.component_id in PRODUCT_ATTRIBUTE_COMPONENT_RENDERERS);

  // D-05/parity-6 — one promise per family, started here but NOT awaited.
  // Previously all six lived in one `await Promise.all(...)`, which blocked
  // the ENTIRE page on whichever family's query was slowest and took the
  // whole route down if any one of them rejected (no SectionErrorBoundary,
  // no Suspense — see docs/audit/D-frontend.md's parity item 6). Each promise
  // below starts executing immediately (a called async function runs
  // synchronously up to its first await) and is awaited independently, once
  // per grid item that needs it, inside that item's own Suspense boundary
  // (see the *FamilyItem components below) — so a workspace with both a Sales
  // KPI grid and a Stock table streams each in as soon as ITS OWN family
  // resolves, and a failing family only takes down the items that read it,
  // never the rest of the grid. Multiple items of the same family (e.g. two
  // Sales KPI grids) all await this SAME promise object, so the underlying
  // query still runs exactly once per family per page render — unchanged
  // from the old Promise.all's fetch cost, only the blocking/isolation
  // behaviour changed.
  const salesDataPromise: Promise<SalesComponentData> | null = needsSalesData
    ? fetchSalesComponentData(
        { supabase, storeIds, from, to, weeklyStart: isoDate(weeklyStart), today, compareFrom, compareTo, metricsById, dimensionsById, dimensionFilters },
        storeNames
      )
    : null;
  const stockDataPromise: Promise<StockComponentData> | null = needsStockData
    ? fetchStockComponentData({ supabase, storeIds, canEditCapacity: user.role === "ho_admin" || user.role === "super_admin" })
    : null;
  const mixDataPromise: Promise<MixComponentData> | null = needsMixData ? fetchMixComponentData({ supabase, storeIds }) : null;
  const replenishmentDataPromise: Promise<ReplenishmentComponentData> | null = needsReplenishmentData
    ? fetchReplenishmentComponentData({ supabase })
    : null;
  const footfallDataPromise: Promise<FootfallInsights> | null = needsFootfallData
    ? fetchFootfallComponentData({ supabase, storeIds, from, to, storeNames })
    : null;
  const targetsDataPromise: Promise<TargetsComponentData> | null = needsTargetsData
    ? fetchTargetsComponentData({ supabase, storeIds })
    : null;
  const productAttributeDataPromise: Promise<SaleAttributeLineRow[]> | null = needsProductAttributeData
    ? fetchProductAttributeComponentData({ supabase, storeIds, from, to })
    : null;

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
  // "a 25-component workspace stays usable" goal. LazyMount only defers
  // MOUNT — every family's query already started above regardless of scroll
  // position (see the *DataPromise comment). Inside that, each item gets its
  // own SectionErrorBoundary + Suspense (parity item 6): a slow or failing
  // component no longer blocks or breaks the rest of the grid.
  const renderedChildren = components.map((c) => {
    const label = registryById.get(c.component_id)?.name ?? c.component_id;
    const fallback = <ChartSkeleton height={140} />;
    if (c.component_id in SALES_COMPONENT_RENDERERS && salesDataPromise) {
      return (
        <LazyMount key={c.id} fallback={fallback}>
          <SectionErrorBoundary label={label}>
            <Suspense fallback={fallback}>
              <SalesFamilyItem dataPromise={salesDataPromise} componentId={c.component_id} />
            </Suspense>
          </SectionErrorBoundary>
        </LazyMount>
      );
    }
    if (c.component_id in STOCK_COMPONENT_RENDERERS && stockDataPromise) {
      return (
        <LazyMount key={c.id} fallback={fallback}>
          <SectionErrorBoundary label={label}>
            <Suspense fallback={fallback}>
              <StockFamilyItem dataPromise={stockDataPromise} componentId={c.component_id} storeIds={storeIds} />
            </Suspense>
          </SectionErrorBoundary>
        </LazyMount>
      );
    }
    if (c.component_id in MIX_COMPONENT_RENDERERS && mixDataPromise) {
      return (
        <LazyMount key={c.id} fallback={fallback}>
          <SectionErrorBoundary label={label}>
            <Suspense fallback={fallback}>
              <MixFamilyItem dataPromise={mixDataPromise} componentId={c.component_id} storeIds={storeIds} />
            </Suspense>
          </SectionErrorBoundary>
        </LazyMount>
      );
    }
    if (c.component_id in REPLENISHMENT_COMPONENT_RENDERERS && replenishmentDataPromise) {
      return (
        <LazyMount key={c.id} fallback={fallback}>
          <SectionErrorBoundary label={label}>
            <Suspense fallback={fallback}>
              <ReplenishmentFamilyItem dataPromise={replenishmentDataPromise} componentId={c.component_id} />
            </Suspense>
          </SectionErrorBoundary>
        </LazyMount>
      );
    }
    if (c.component_id in FOOTFALL_COMPONENT_RENDERERS && footfallDataPromise) {
      return (
        <LazyMount key={c.id} fallback={fallback}>
          <SectionErrorBoundary label={label}>
            <Suspense fallback={fallback}>
              <FootfallFamilyItem dataPromise={footfallDataPromise} componentId={c.component_id} />
            </Suspense>
          </SectionErrorBoundary>
        </LazyMount>
      );
    }
    if (c.component_id in TARGETS_COMPONENT_RENDERERS && targetsDataPromise) {
      return (
        <LazyMount key={c.id} fallback={fallback}>
          <SectionErrorBoundary label={label}>
            <Suspense fallback={fallback}>
              <TargetsFamilyItem dataPromise={targetsDataPromise} componentId={c.component_id} />
            </Suspense>
          </SectionErrorBoundary>
        </LazyMount>
      );
    }
    if (c.component_id in PRODUCT_ATTRIBUTE_COMPONENT_RENDERERS && productAttributeDataPromise) {
      return (
        <LazyMount key={c.id} fallback={fallback}>
          <SectionErrorBoundary label={label}>
            <Suspense fallback={fallback}>
              <ProductAttributeFamilyItem dataPromise={productAttributeDataPromise} componentId={c.component_id} />
            </Suspense>
          </SectionErrorBoundary>
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
          initialCompareFrom={compareFrom}
          initialCompareTo={compareTo}
        />
      </div>

      <div className="mt-5">
        <ScheduledExportsPanel initialSchedules={myScheduledExports} />
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
