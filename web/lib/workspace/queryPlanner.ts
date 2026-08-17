import "server-only";
import type { DataClient, QueryChain } from "@/lib/data/client";
import type { MetricDefinition, DimensionDefinition } from "./semantic";

/**
 * Phase 4 — Query Requirement Engine (blueprint §J). Turns component
 * configuration into the smallest set of physical queries that satisfies
 * it, via four passes: resolve, group, push-down, schedule. This module
 * implements passes 1-3 (resolve/push-down/group); pass 4 (eager/deferred
 * scheduling into Suspense boundaries) is a page-authoring concern, applied
 * by hand on the 5 pages refactored in Phase 1 — nothing here decides that
 * automatically yet.
 *
 * Scope, deliberately narrow per the roadmap ("ship exact-match grouping
 * only, everything else waits"):
 *   - Only metrics with sourceKind 'view_column' are plannable. A metric
 *     backed by an RPC (sql_expression) or by TypeScript (js_computed) has
 *     no single column this planner can select — those stay handled by
 *     hand-written page code, same as today.
 *   - Grouping is EXACT-MATCH ONLY: two requirements merge into one query
 *     only when they need the identical (view, date column, period, store
 *     filter). No partial-overlap merging, no predicate subsumption — the
 *     blueprint calls those real optimizations that also make a planner
 *     unpredictable, and defers them until the simple version is proven.
 *   - First real caller: lib/workspace/renderSalesComponents.tsx's daily
 *     net_sales trend fetch (Phase 5's SalesTrendChart) — routed through
 *     this planner because 'net_sales' on sales.vw_ebo_sales_daily is an
 *     exact-match, unambiguous view_column metric untouched by the
 *     weekly-rollup ATV/UPT nuance documented in that file's header. The
 *     KPI grid/league table/weekly table stay on the hand-written weekly
 *     fetch, and scheme/hourly stay hand-written too (no metric_definitions
 *     rows point at vw_ebo_scheme_daily or vw_ebo_sales_hourly yet — adding
 *     those is a migration + parity-check exercise, not done here).
 *     Also proven correct by lib/workspace/__verify__/queryPlanner.mjs
 *     against the same synthetic fixture the Phase 3 parity harness uses.
 *
 * The governing invariant carried forward unchanged from Phase 0/1: filters
 * here can only NARROW within whatever RLS already permits for the caller.
 * This planner never constructs a query that widens access — it has no
 * concept of "all stores" that bypasses core.fn_user_store_ids(), because
 * every query it builds still runs through the same DataClient/PostgREST
 * path as hand-written page code, which RLS scopes identically either way.
 */

// ---------------------------------------------------------------------------
// View metadata the planner needs but the Phase 3 semantic layer doesn't
// carry yet (which column filters by date, per view). Kept as a small,
// explicitly-cited TS lookup rather than another migration — each entry is
// copied from the exact query already live in the pages this reuses.
// Folding this into workspace.dimension_definitions.source_view is a
// reasonable next step, not done here to avoid re-touching Phase 3's schema
// mid-verification.
// ---------------------------------------------------------------------------
const VIEW_DATE_COLUMN: Record<string, string> = {
  "sales.vw_ebo_sales_daily": "bill_date", // app/(ho)/network/page.tsx SalesSection
  "sales.vw_ebo_sales_weekly": "week_start", // app/(ho)/network/page.tsx SalesSection
  "sales.vw_ebo_scheme_daily": "bill_date", // app/(ho)/network/page.tsx SalesSection
  "sales.vw_ebo_agent_daily": "bill_date", // app/(ho)/network/page.tsx SalesSection
  "sales.vw_ebo_sales_hourly": "bill_date", // app/(ho)/network/page.tsx SalesSection
  "ops.vw_ebo_conversion_daily": "bill_date", // app/(ho)/network/page.tsx FootfallSection
  "ops.vw_footfall_completeness": "date", // app/(ho)/network/page.tsx FootfallSection
};
const VIEW_STORE_COLUMN: Record<string, string> = {
  "sales.vw_ebo_sales_daily": "store_id",
  "sales.vw_ebo_sales_weekly": "store_id",
  "sales.vw_ebo_scheme_daily": "store_id",
  "sales.vw_ebo_agent_daily": "store_id",
  "sales.vw_ebo_sales_hourly": "store_id",
  "ops.vw_ebo_conversion_daily": "store_id",
  "ops.vw_footfall_completeness": "store_id",
};

export type Period = { from: string; to: string }; // ISO dates, already resolved — "mtd"/"ytd" -> concrete range is the caller's job, same as every page today
export type Comparison = "none" | "previous_period";

/**
 * Phase 6 — a governed filter on a dimension from
 * workspace.dimension_definitions. Values are matched with IN semantics
 * (an empty list means "no constraint", consistent with how storeIds
 * already behaves).
 */
export type DimensionPredicate = { dimensionId: string; values: string[] };

export type Filters = {
  /**
   * Store stays a distinct field rather than just another DimensionPredicate:
   * every fact view carries store_id (VIEW_STORE_COLUMN), it is the axis RLS
   * itself scopes on, and the "empty list = whatever RLS allows" semantic is
   * load-bearing. Folding it into the generic path would make that special
   * behavior implicit.
   */
  storeIds?: string[];
  /** Additional governed dimension filters. Narrowing only, same invariant as storeIds. */
  dimensions?: DimensionPredicate[];
};

export type QueryRequirement = {
  componentId: string;
  metricIds: string[];
  period: Period;
  comparison: Comparison;
  filters: Filters;
  /**
   * Non-metric columns the component also needs in the row (retail_week for
   * a week series, scheme_group to group by, bill_hour to bucket by).
   *
   * Deliberately an explicit escape hatch rather than dimension resolution
   * via workspace.dimension_definitions: the dimension catalogue keys a
   * dimension to ONE source_view (retail_week -> core.retail_calendar), but
   * these columns are needed as they appear on the view being queried, and
   * a dimension id can't be registered twice for two views. Pretending to
   * resolve them through the catalogue would be a lookup that silently
   * misses. Each entry below is cited at its call site instead.
   *
   * Applied per (view, requirement) pair — a column named here is added to
   * every query this requirement resolves to. Harmless when a requirement
   * only touches one view, which is the case for every caller today; revisit
   * if a multi-view requirement ever needs view-specific extras.
   */
  extraColumns?: string[];
};

export type PeriodRole = "current" | "previous";

/** A dimension predicate resolved to a concrete column on THIS query's view. */
export type AppliedPredicate = { dimensionId: string; column: string; values: string[] };

export type ResolvedQuery = {
  sourceView: string; // 'schema.table'
  columns: string[]; // deduped source columns this query must select
  dateColumn: string;
  storeColumn: string;
  period: Period;
  periodRole: PeriodRole;
  filters: Filters;
  /** Dimension predicates that resolve to a real column on sourceView and WILL be applied by buildQuery(). */
  appliedPredicates: AppliedPredicate[];
  /**
   * Requested dimension filters this query CANNOT express — the dimension is
   * catalogued against a different view (e.g. 'gender' lives on
   * sales.vw_item_gender_options, reachable only through a join this planner
   * does not do).
   *
   * A caller MUST treat a non-empty list as "do not run this query": silently
   * dropping a filter returns UNFILTERED rows that look filtered, which is a
   * correctness bug, not a missing feature. Surfaced for the same reason
   * unplannableMetricIds is.
   */
  unappliedDimensionIds: string[];
  servedRequirements: string[]; // componentIds this query's result must be handed to — >1 after grouping
  unplannableMetricIds: string[]; // metrics on the parent requirement this query does NOT cover (sql_expression/js_computed) — surfaced, never silently dropped
};

function previousPeriodOf(period: Period): Period {
  const periodDays = Math.round((new Date(period.to).getTime() - new Date(period.from).getTime()) / 86400000) + 1;
  const prevTo = new Date(period.from);
  prevTo.setDate(prevTo.getDate() - 1);
  const prevFrom = new Date(prevTo);
  prevFrom.setDate(prevFrom.getDate() - (periodDays - 1));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(prevFrom), to: iso(prevTo) };
}

/**
 * Pass 1 (resolve): a requirement's metrics may span multiple source views
 * (e.g. net_sales lives in sales.vw_ebo_sales_daily, conversion_pct in
 * ops.vw_ebo_conversion_daily) — one requirement can resolve to several
 * ResolvedQuery entries, one per distinct view actually needed, and two
 * (current + previous) per view when comparison = 'previous_period'.
 */
export function resolveRequirement(
  requirement: QueryRequirement,
  metricsById: Map<string, MetricDefinition>,
  /**
   * Phase 6. Optional so every existing caller keeps working unchanged: with
   * no catalogue passed, a requirement carrying dimension filters resolves
   * them all as UNAPPLIED (never as "no filter"), which callers must reject.
   * Failing closed is the only safe default here.
   */
  dimensionsById?: Map<string, DimensionDefinition>
): ResolvedQuery[] {
  const byView = new Map<string, string[]>(); // sourceView -> columns
  const unplannable: string[] = [];

  for (const metricId of requirement.metricIds) {
    const metric = metricsById.get(metricId);
    if (!metric || metric.sourceKind !== "view_column" || !metric.sourceView || !metric.sourceColumn) {
      unplannable.push(metricId);
      continue;
    }
    const cols = byView.get(metric.sourceView) ?? [];
    if (!cols.includes(metric.sourceColumn)) cols.push(metric.sourceColumn);
    byView.set(metric.sourceView, cols);
  }

  const periods: { period: Period; role: PeriodRole }[] =
    requirement.comparison === "previous_period"
      ? [
          { period: requirement.period, role: "current" },
          { period: previousPeriodOf(requirement.period), role: "previous" },
        ]
      : [{ period: requirement.period, role: "current" }];

  const resolved: ResolvedQuery[] = [];
  for (const [sourceView, columns] of byView) {
    const dateColumn = VIEW_DATE_COLUMN[sourceView];
    const storeColumn = VIEW_STORE_COLUMN[sourceView];
    if (!dateColumn || !storeColumn) {
      // View not in the lookup — cannot be planned safely, surface as
      // unplannable rather than guessing a column name.
      unplannable.push(...requirement.metricIds.filter((id) => metricsById.get(id)?.sourceView === sourceView));
      continue;
    }
    // The row shape every caller actually needs includes the date/store
    // columns used for grouping and display, not just the metric value
    // columns — select() always carries both, even if no requested metric
    // happens to be one of them.
    // Resolve each requested dimension filter against THIS view. A predicate
    // applies only when the catalogue says the dimension lives on this very
    // view — a dimension catalogued elsewhere would need a join, so it is
    // reported unapplied rather than quietly ignored.
    const applied: AppliedPredicate[] = [];
    const unapplied: string[] = [];
    for (const predicate of requirement.filters.dimensions ?? []) {
      if (predicate.values.length === 0) continue; // empty = no constraint, same as storeIds
      const dimension = dimensionsById?.get(predicate.dimensionId);
      if (!dimension || dimension.sourceView !== sourceView || !dimension.sourceColumn) {
        unapplied.push(predicate.dimensionId);
        continue;
      }
      applied.push({ dimensionId: predicate.dimensionId, column: dimension.sourceColumn, values: predicate.values });
    }

    const selectColumns = [
      ...new Set([dateColumn, storeColumn, ...columns, ...(requirement.extraColumns ?? []), ...applied.map((p) => p.column)]),
    ];
    for (const { period, role } of periods) {
      resolved.push({
        sourceView,
        columns: [...selectColumns],
        dateColumn,
        storeColumn,
        period,
        periodRole: role,
        filters: requirement.filters,
        appliedPredicates: applied.map((p) => ({ ...p, values: [...p.values] })),
        unappliedDimensionIds: [...unapplied],
        servedRequirements: [requirement.componentId],
        unplannableMetricIds: unplannable,
      });
    }
  }
  return resolved;
}

/**
 * Pass 2 (group): merge ResolvedQuery entries that are IDENTICAL on
 * (sourceView, dateColumn, period, periodRole, store filter). Column lists
 * union; servedRequirements union. This is the only grouping strategy this
 * phase implements — see header for why partial-overlap merging waits.
 */
export function groupResolvedQueries(queries: ResolvedQuery[]): ResolvedQuery[] {
  const groups = new Map<string, ResolvedQuery>();
  for (const q of queries) {
    const storeKey = [...(q.filters.storeIds ?? [])].sort().join(",");
    // Dimension predicates are part of the identity of a query: two
    // requirements filtered differently must NEVER share one physical query,
    // or one of them silently gets the other's rows. Sorted on both axes so
    // the key is order-insensitive.
    const predicateKey = q.appliedPredicates
      .map((p) => `${p.dimensionId}=${[...p.values].sort().join("|")}`)
      .sort()
      .join(";");
    // Unapplied dimensions also distinguish a query — an unsatisfiable query
    // must not merge into a satisfiable one and inherit its "runnable" status.
    const unappliedKey = [...q.unappliedDimensionIds].sort().join(",");
    const key = `${q.sourceView}::${q.dateColumn}::${q.period.from}::${q.period.to}::${q.periodRole}::${storeKey}::${predicateKey}::${unappliedKey}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        ...q,
        columns: [...q.columns],
        appliedPredicates: q.appliedPredicates.map((p) => ({ ...p, values: [...p.values] })),
        unappliedDimensionIds: [...q.unappliedDimensionIds],
        servedRequirements: [...q.servedRequirements],
      });
      continue;
    }
    for (const col of q.columns) if (!existing.columns.includes(col)) existing.columns.push(col);
    for (const req of q.servedRequirements)
      if (!existing.servedRequirements.includes(req)) existing.servedRequirements.push(req);
  }
  return [...groups.values()];
}

/**
 * Convenience: resolve N requirements and group the results in one call —
 * what a page (or, eventually, a workspace) actually calls.
 */
export function planQueries(
  requirements: QueryRequirement[],
  metricsById: Map<string, MetricDefinition>,
  dimensionsById?: Map<string, DimensionDefinition>
): ResolvedQuery[] {
  const all = requirements.flatMap((r) => resolveRequirement(r, metricsById, dimensionsById));
  return groupResolvedQueries(all);
}

/**
 * Whether a planned query is safe to execute: every requested metric was
 * plannable AND every requested dimension filter resolved to a real column.
 * Callers should gate on this rather than inspecting the two arrays
 * separately and risking one being forgotten.
 */
export function isSatisfiable(resolved: ResolvedQuery): boolean {
  return resolved.unplannableMetricIds.length === 0 && resolved.unappliedDimensionIds.length === 0;
}

/**
 * Pass 3 (push down): turn a ResolvedQuery into an actual PostgREST call.
 * Filters narrow only — storeIds is applied with .eq/.in exactly like the
 * applyStore() helper on the Network page (Phase 1), never a WHERE clause
 * that could widen what RLS already scoped the caller to.
 */
export function buildQuery<T = unknown>(supabase: DataClient, resolved: ResolvedQuery): QueryChain<T> {
  // Refuse to build a query that would drop a requested filter. Returning
  // unfiltered rows that the caller believes are filtered is worse than
  // failing — this throws rather than degrading silently. Check
  // isSatisfiable() first if a fallback path is wanted.
  if (resolved.unappliedDimensionIds.length > 0) {
    throw new Error(
      `Cannot build query on ${resolved.sourceView}: dimension filter(s) [${resolved.unappliedDimensionIds.join(", ")}] ` +
        `have no column on this view. Running it would silently return unfiltered rows.`
    );
  }

  const [schema, table] = resolved.sourceView.split(".") as [string, string];
  let query = supabase
    .schema(schema)
    .from<T>(table)
    .select(resolved.columns.join(","))
    .gte(resolved.dateColumn, resolved.period.from)
    .lte(resolved.dateColumn, resolved.period.to) as QueryChain<T>;

  const storeIds = resolved.filters.storeIds ?? [];
  if (storeIds.length === 1) {
    query = query.eq(resolved.storeColumn, storeIds[0]!);
  } else if (storeIds.length > 1) {
    query = query.in(resolved.storeColumn, storeIds);
  }

  for (const predicate of resolved.appliedPredicates) {
    query = predicate.values.length === 1
      ? query.eq(predicate.column, predicate.values[0]!)
      : query.in(predicate.column, predicate.values);
  }
  return query;
}
