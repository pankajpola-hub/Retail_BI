import "server-only";
import type { DataClient } from "@/lib/data/client";

/**
 * Typed read access to workspace.metric_definitions / dimension_definitions
 * (migration 0048, Phase 3 of the Retail Intelligence Workspace blueprint).
 *
 * This is a catalogue, not a calculation engine — nothing here computes a
 * metric. It answers "what does ATV mean and where does it come from," not
 * "what is Undri's ATV this week." No page reads from this module yet
 * (that's Phase 4's Query Planner). Same non-caching posture as
 * lib/workspace/registry.ts — see that file's header for why.
 */

export type MetricUnit =
  | "currency_inr"
  | "count"
  | "percent"
  | "percentage_points"
  | "ratio"
  | "days"
  | "score"
  | "text";

export type MetricSourceKind = "view_column" | "sql_expression" | "js_computed";

export type MetricDefinition = {
  id: string;
  label: string;
  description: string;
  unit: MetricUnit;
  decimals: number;

  sourceKind: MetricSourceKind;
  sourceView: string | null;
  sourceColumn: string | null;
  sourceExpression: string | null;

  /** Non-null means this metric is a ratio/derived value that must be re-derived from requiresMetrics when rolling up to a coarser grain — never summed or averaged directly. */
  rollupStrategy: string | null;
  requiresMetrics: string[];

  provenance: string;
  verifiedAgainst: string | null;
  isVerified: boolean;
};

export type DimensionSourceKind = "view_column" | "calendar" | "lookup";

export type DimensionDefinition = {
  id: string;
  label: string;
  description: string;
  sourceKind: DimensionSourceKind;
  sourceView: string | null;
  sourceColumn: string | null;
  provenance: string;
};

type MetricDefinitionRow = {
  id: string;
  label: string;
  description: string;
  unit: string;
  decimals: number;
  source_kind: string;
  source_view: string | null;
  source_column: string | null;
  source_expression: string | null;
  rollup_strategy: string | null;
  requires_metrics: string[];
  provenance: string;
  verified_against: string | null;
  is_verified: boolean;
};

type DimensionDefinitionRow = {
  id: string;
  label: string;
  description: string;
  source_kind: string;
  source_view: string | null;
  source_column: string | null;
  provenance: string;
};

function mapMetric(row: MetricDefinitionRow): MetricDefinition {
  return {
    id: row.id,
    label: row.label,
    description: row.description,
    unit: row.unit as MetricUnit,
    decimals: row.decimals,
    sourceKind: row.source_kind as MetricSourceKind,
    sourceView: row.source_view,
    sourceColumn: row.source_column,
    sourceExpression: row.source_expression,
    rollupStrategy: row.rollup_strategy,
    requiresMetrics: row.requires_metrics,
    provenance: row.provenance,
    verifiedAgainst: row.verified_against,
    isVerified: row.is_verified,
  };
}

function mapDimension(row: DimensionDefinitionRow): DimensionDefinition {
  return {
    id: row.id,
    label: row.label,
    description: row.description,
    sourceKind: row.source_kind as DimensionSourceKind,
    sourceView: row.source_view,
    sourceColumn: row.source_column,
    provenance: row.provenance,
  };
}

const METRIC_COLUMNS =
  "id, label, description, unit, decimals, source_kind, source_view, source_column, " +
  "source_expression, rollup_strategy, requires_metrics, provenance, verified_against, is_verified";

const DIMENSION_COLUMNS = "id, label, description, source_kind, source_view, source_column, provenance";

export async function listMetricDefinitions(supabase: DataClient): Promise<MetricDefinition[]> {
  const { data, error } = await supabase
    .schema("workspace")
    .from<MetricDefinitionRow>("metric_definitions")
    .select(METRIC_COLUMNS)
    .order("id");
  if (error) throw new Error(`Failed to load metric definitions: ${error.message}`);
  return (data ?? []).map(mapMetric);
}

export async function getMetricDefinition(supabase: DataClient, id: string): Promise<MetricDefinition | null> {
  const { data, error } = await supabase
    .schema("workspace")
    .from<MetricDefinitionRow>("metric_definitions")
    .select(METRIC_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Failed to load metric "${id}": ${error.message}`);
  return data ? mapMetric(data) : null;
}

/** The specific metrics a caller intends to plan against, in one round trip. Ids with no row are simply absent from the result — the caller decides whether that's fatal or a fallback. */
export async function listMetricDefinitionsByIds(supabase: DataClient, ids: string[]): Promise<MetricDefinition[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabase
    .schema("workspace")
    .from<MetricDefinitionRow>("metric_definitions")
    .select(METRIC_COLUMNS)
    .in("id", ids);
  if (error) throw new Error(`Failed to load metric definitions [${ids.join(", ")}]: ${error.message}`);
  return (data ?? []).map(mapMetric);
}

/** Metrics that are safe to build a component on today — unverified metrics still describe real production behavior, but a future consumer should surface that distinction rather than treat every row as equally trustworthy. */
export async function listVerifiedMetricDefinitions(supabase: DataClient): Promise<MetricDefinition[]> {
  const { data, error } = await supabase
    .schema("workspace")
    .from<MetricDefinitionRow>("metric_definitions")
    .select(METRIC_COLUMNS)
    .eq("is_verified", true)
    .order("id");
  if (error) throw new Error(`Failed to load verified metric definitions: ${error.message}`);
  return (data ?? []).map(mapMetric);
}

export async function listDimensionDefinitions(supabase: DataClient): Promise<DimensionDefinition[]> {
  const { data, error } = await supabase
    .schema("workspace")
    .from<DimensionDefinitionRow>("dimension_definitions")
    .select(DIMENSION_COLUMNS)
    .order("id");
  if (error) throw new Error(`Failed to load dimension definitions: ${error.message}`);
  return (data ?? []).map(mapDimension);
}

export async function getDimensionDefinition(supabase: DataClient, id: string): Promise<DimensionDefinition | null> {
  const { data, error } = await supabase
    .schema("workspace")
    .from<DimensionDefinitionRow>("dimension_definitions")
    .select(DIMENSION_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Failed to load dimension "${id}": ${error.message}`);
  return data ? mapDimension(data) : null;
}
