import "server-only";
import type { DataClient } from "@/lib/data/client";
import type { PageKey } from "@/lib/auth/roles";

/**
 * Typed read access to workspace.component_definitions (migration 0047,
 * Phase 2 of the Retail Intelligence Workspace blueprint). This is a
 * read-only catalogue today — nothing renders FROM it yet, and nothing here
 * writes to it (writes are super_admin-only at the RLS layer, with no admin
 * UI built for it in this phase).
 *
 * Caching note: this table is non-user-scoped and changes rarely (only when
 * a new component ships), which is exactly the profile the Phase 1
 * blueprint flagged as safe for the long-lived cache tier — same category as
 * core.stores/core.retail_calendar. NOT cached here yet; that's a Phase 1d
 * decision this phase deliberately didn't reopen. Every call below hits
 * PostgREST fresh, consistent with the rest of the app's current posture.
 */

export type ComponentCategory = "sales" | "footfall" | "stock" | "targets" | "replenishment" | "mix";
export type ComponentCost = "low" | "medium" | "high";
export type ComponentLoad = "eager" | "deferred";
export type VisualType = "kpi" | "line" | "bar" | "table" | "matrix" | "list" | "form";

export type ComponentDefinition = {
  id: string;
  name: string;
  category: ComponentCategory;
  description: string;

  sourcePage: string;
  requiresPageKey: PageKey;

  supportedMetrics: string[];
  supportedDimensions: string[];
  supportedComparisons: string[];
  supportedPeriods: string[];
  supportedVisuals: VisualType[];

  minW: number;
  minH: number;
  defaultW: number;
  defaultH: number;

  cost: ComponentCost;
  load: ComponentLoad;
  isInteractive: boolean;
};

// Raw shape as PostgREST returns it (snake_case columns) — kept private,
// mapToComponentDefinition() is the only place that translates between the
// two, so a column rename only ever touches one function.
type ComponentDefinitionRow = {
  id: string;
  name: string;
  category: string;
  description: string;
  source_page: string;
  requires_page_key: string;
  supported_metrics: string[];
  supported_dimensions: string[];
  supported_comparisons: string[];
  supported_periods: string[];
  supported_visuals: string[];
  min_w: number;
  min_h: number;
  default_w: number;
  default_h: number;
  cost: string;
  load: string;
  is_interactive: boolean;
};

function mapToComponentDefinition(row: ComponentDefinitionRow): ComponentDefinition {
  return {
    id: row.id,
    name: row.name,
    category: row.category as ComponentCategory,
    description: row.description,
    sourcePage: row.source_page,
    requiresPageKey: row.requires_page_key as PageKey,
    supportedMetrics: row.supported_metrics,
    supportedDimensions: row.supported_dimensions,
    supportedComparisons: row.supported_comparisons,
    supportedPeriods: row.supported_periods,
    supportedVisuals: row.supported_visuals as VisualType[],
    minW: row.min_w,
    minH: row.min_h,
    defaultW: row.default_w,
    defaultH: row.default_h,
    cost: row.cost as ComponentCost,
    load: row.load as ComponentLoad,
    isInteractive: row.is_interactive,
  };
}

const SELECT_COLUMNS =
  "id, name, category, description, source_page, requires_page_key, " +
  "supported_metrics, supported_dimensions, supported_comparisons, supported_periods, supported_visuals, " +
  "min_w, min_h, default_w, default_h, cost, load, is_interactive";

export async function listComponentDefinitions(supabase: DataClient): Promise<ComponentDefinition[]> {
  const { data, error } = await supabase
    .schema("workspace")
    .from<ComponentDefinitionRow>("component_definitions")
    .select(SELECT_COLUMNS)
    .order("category")
    .order("id");
  if (error) throw new Error(`Failed to load component registry: ${error.message}`);
  return (data ?? []).map(mapToComponentDefinition);
}

export async function listComponentDefinitionsByCategory(
  supabase: DataClient,
  category: ComponentCategory
): Promise<ComponentDefinition[]> {
  const { data, error } = await supabase
    .schema("workspace")
    .from<ComponentDefinitionRow>("component_definitions")
    .select(SELECT_COLUMNS)
    .eq("category", category)
    .order("id");
  if (error) throw new Error(`Failed to load component registry: ${error.message}`);
  return (data ?? []).map(mapToComponentDefinition);
}

/** Components a given page is allowed to surface, per requires_page_key — the registry's own guard against becoming a side door around the existing per-page RBAC gate (see migration 0047 header). */
export async function listComponentDefinitionsForPage(
  supabase: DataClient,
  pageKey: PageKey
): Promise<ComponentDefinition[]> {
  const { data, error } = await supabase
    .schema("workspace")
    .from<ComponentDefinitionRow>("component_definitions")
    .select(SELECT_COLUMNS)
    .eq("requires_page_key", pageKey)
    .order("id");
  if (error) throw new Error(`Failed to load component registry: ${error.message}`);
  return (data ?? []).map(mapToComponentDefinition);
}

export async function getComponentDefinition(
  supabase: DataClient,
  id: string
): Promise<ComponentDefinition | null> {
  const { data, error } = await supabase
    .schema("workspace")
    .from<ComponentDefinitionRow>("component_definitions")
    .select(SELECT_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Failed to load component "${id}": ${error.message}`);
  return data ? mapToComponentDefinition(data) : null;
}
