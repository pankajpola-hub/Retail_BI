/**
 * Product-attribute FILTERING for /sales — the shared vocabulary behind
 * AttributeFilterBar and every section that reads
 * sales.vw_ebo_sale_attribute_lines (0092 + 0103).
 *
 * Distinct from lib/sales/attributeBreakdown.ts, which is about GROUPING
 * ("bucket these lines by Season + Gender"). This file is about NARROWING
 * ("only the lines whose Category is DRESSES"). They compose: a filtered set
 * of lines is still a valid input to aggregateSalesByAttributes().
 *
 * ---------------------------------------------------------------------------
 * Why the option lists come from the sale LINES, not from raw_logic.item_master
 * ---------------------------------------------------------------------------
 * The obvious source for "every real Category" is raw_logic.item_master. The
 * web client cannot read it: `authenticated` has no grant on the raw_logic
 * schema at all, which is the entire reason 0092 exists as a view in the first
 * place (see its header). Every attribute value this app shows already reaches
 * the browser through a view that joins item_master server-side.
 *
 * So the options are derived from the same store-scoped view the sections
 * already fetch. This is not a workaround, it is strictly better here:
 *
 *   * Store scoping comes free. An ebo_manager's option list is built from
 *     their own stores' lines, so it cannot advertise a Category that only
 *     ever sold in a store they are not allowed to see — which a global
 *     item_master list would.
 *   * The lists describe what actually SOLD in the window, not the 93,380-row
 *     catalogue. A filter offering 63 subcategories when 6 of them have any
 *     sales in view is a worse control, not a more complete one.
 *
 * ---------------------------------------------------------------------------
 * Why only Category -> Subcategory cascades, and not all eight facets
 * ---------------------------------------------------------------------------
 * A full N-way cascade (every facet's options narrowed by every other facet's
 * selection, the way FacetFilterBar does it) needs the whole row universe in
 * the browser, because the counts are recomputed per keystroke. Measured
 * against the live DB, `select distinct` over the eight attribute columns of
 * raw_logic.item_master returns 37,476 combinations — several MB of JSON, and
 * this bar is instantiated FOUR times on the page (one shared + three
 * independent tables). That is not a payload worth spending for the ask.
 *
 * Category -> Subcategory is the one pair that genuinely needs it, and it is
 * cheap: subcategories are a strict partition of categories (verified live —
 * `select subcategory ... having count(distinct category) > 1` returns 0 rows),
 * so the whole relationship is carried by at most ~63 (category, subcategory)
 * pairs. The other six facets are flat lists of at most ~51 values each.
 *
 * The dimming rule is taken verbatim from FacetFilterBar's facetOptionCounts:
 * a value the user has CURRENTLY SELECTED stays in the list even when the
 * other selections would give it zero rows — it is shown dimmed, never
 * silently removed, so a user can always see and undo their own picks.
 */

import type { SaleAttributeLineRow } from "./attributeBreakdown";

/**
 * A line as the /sales sections now read it — 0092's columns plus the three
 * 0103 added. `size` is item_master's exact size (0087), which 0092 did not
 * carry at all; `agent_name` and `bill_time` are what let the agent-wise and
 * hour-of-day displays be attribute-filtered without falling back to the
 * pre-aggregated rollups, which carry no attributes.
 *
 * bill_time arrives as a PostgREST time string ("14:35:07"), not a Date.
 */
export type SaleLineRow = SaleAttributeLineRow & {
  item_code?: string | null;
  size: string | null;
  agent_name: string | null;
  bill_time: string | null;
  /**
   * The line's own scheme group. Scheme penetration resolves a single
   * DOMINANT group per bill from these (see computeSchemeFromLines) — it is
   * not itself one of the eight filter facets.
   */
  scheme_group_name: string | null;
  /**
   * Retail calendar, carried onto the line by 0103. A retail week is not an
   * ISO week and a financial year is not a calendar year, so these are read
   * from core.retail_calendar rather than derived from bill_date — see
   * lib/sales/lineRollups.ts. Nullable because the join is a LEFT join: a bill
   * dated past the end of the seeded calendar still counts in the money
   * figures, it just has no period.
   */
  week_start: string | null;
  retail_week: number | null;
  financial_year: string | null;
  month_start: string | null;
};

/** The column list every /sales section selects from the view. */
export const SALE_LINE_SELECT =
  "store_id, bill_date, bill_no, bill_type, item_code, total_quantity, gross_amount, net_amount, season, market_segment, category, subcategory, gender, size_group, shade_name, mrp, size, agent_name, bill_time, scheme_group_name, week_start, retail_week, financial_year, month_start";

/** Same sentinel, same meaning, as attributeBreakdown.ts's own UNCLASSIFIED. */
export const UNCLASSIFIED = "—";

const orDash = (v: string | null | undefined): string => {
  const t = (v ?? "").trim();
  return t === "" ? UNCLASSIFIED : t;
};

export type AttributeFacetKey =
  | "category"
  | "subcategory"
  | "gender"
  | "marketSegment"
  | "sizeGroup"
  | "season"
  | "shade"
  | "size";

/**
 * The eight facets, in the order they render. `param` is the SUFFIX appended
 * to the bar's paramPrefix — see AttributeFilterBar's header for why a prefix
 * exists at all.
 *
 * `season` is deliberately the raw combined token ("SS2026"), not a split
 * season/year pair: that token IS season+year (0030 verified it straight off
 * the ERP), which is exactly why attributeBreakdown.ts labels the same field
 * "Season + Year". Splitting it is a GROUPING affordance (seasonCodeOf /
 * seasonYearOf, for asking "how does Summer do across every year"); as a
 * FILTER the user picks the concrete collection, so the token is the value.
 */
export const ATTRIBUTE_FACETS: {
  key: AttributeFacetKey;
  param: string;
  label: string;
  get: (r: SaleLineRow) => string;
  /** Long value lists get a searchable popover instead of a plain one. */
  searchable: boolean;
}[] = [
  { key: "category", param: "cat", label: "Category", get: (r) => orDash(r.category), searchable: false },
  { key: "subcategory", param: "subcat", label: "Subcategory", get: (r) => orDash(r.subcategory), searchable: true },
  { key: "gender", param: "gender", label: "Gender", get: (r) => orDash(r.gender), searchable: false },
  { key: "marketSegment", param: "mseg", label: "Market Segment", get: (r) => orDash(r.market_segment), searchable: false },
  { key: "sizeGroup", param: "sizegrp", label: "Size Group", get: (r) => orDash(r.size_group), searchable: false },
  { key: "season", param: "season", label: "Season + Year", get: (r) => orDash(r.season), searchable: false },
  { key: "shade", param: "shade", label: "Color", get: (r) => orDash(r.shade_name), searchable: true },
  { key: "size", param: "size", label: "Size", get: (r) => orDash(r.size), searchable: true },
];

/** Selected values per facet. An absent/empty entry means "no filter on this facet". */
export type AttributeSelection = Record<AttributeFacetKey, string[]>;

export function emptyAttributeSelection(): AttributeSelection {
  return {
    category: [],
    subcategory: [],
    gender: [],
    marketSegment: [],
    sizeGroup: [],
    season: [],
    shade: [],
    size: [],
  };
}

/** Full URL param name for a facet under a given prefix, e.g. "attr_" + "cat". */
export function attributeParamName(prefix: string, key: AttributeFacetKey): string {
  const facet = ATTRIBUTE_FACETS.find((f) => f.key === key);
  return `${prefix}${facet?.param ?? key}`;
}

/**
 * Reads a selection out of a plain searchParams object (the shape a Server
 * Component receives). Comma-separated, same "unfiltered == param absent"
 * convention every other filter on this page uses.
 */
export function parseAttributeSelection(
  searchParams: Record<string, string | string[] | undefined>,
  prefix: string
): AttributeSelection {
  const sel = emptyAttributeSelection();
  for (const facet of ATTRIBUTE_FACETS) {
    const raw = searchParams[`${prefix}${facet.param}`];
    const value = Array.isArray(raw) ? raw[0] : raw;
    sel[facet.key] = (value ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  }
  return sel;
}

export function isAttributeSelectionEmpty(sel: AttributeSelection): boolean {
  return ATTRIBUTE_FACETS.every((f) => sel[f.key].length === 0);
}

export function countActiveAttributeFacets(sel: AttributeSelection): number {
  return ATTRIBUTE_FACETS.filter((f) => sel[f.key].length > 0).length;
}

/**
 * Does one line pass every facet EXCEPT `exceptKey`?
 *
 * Directly mirrors FacetFilterBar's rowMatchesFacets/rowsExcludingFacet pair:
 * excluding a facet's own key is what lets that facet's option list be
 * computed without the facet hiding its own current picks. A facet with no
 * selection never narrows anything (empty == unfiltered, not == match nothing).
 */
function lineMatches(line: SaleLineRow, sel: AttributeSelection, exceptKey: AttributeFacetKey | null): boolean {
  for (const facet of ATTRIBUTE_FACETS) {
    if (facet.key === exceptKey) continue;
    const chosen = sel[facet.key];
    if (chosen.length === 0) continue;
    if (!chosen.includes(facet.get(line))) return false;
  }
  return true;
}

/**
 * The filter itself. Applied in memory over lines already fetched for the
 * section's date/store scope, NOT pushed into the PostgREST query — the
 * sections fetch their line set once and then need BOTH the filtered rows
 * (for the figures) and the unfiltered rows (for the option lists), so
 * narrowing at the database would throw away exactly what the filter bar
 * needs to stay cascading.
 */
export function applyAttributeFilter(lines: SaleLineRow[], sel: AttributeSelection): SaleLineRow[] {
  if (isAttributeSelectionEmpty(sel)) return lines;
  return lines.filter((l) => lineMatches(l, sel, null));
}

/**
 * The option lists a bar renders, derived from the section's UNFILTERED lines.
 *
 * `counts` per facet follow facetOptionCounts exactly: computed over the rows
 * passing every OTHER facet, with any currently-selected value forced into the
 * map at 0 rather than dropped. `categoryOf` carries the Category ->
 * Subcategory relationship so the Subcategory list can narrow to the selected
 * categories without a second server round-trip.
 */
export type AttributeOptions = {
  /** facet key -> (value -> row count under the other facets' selections) */
  counts: Record<AttributeFacetKey, [string, number][]>;
  /** subcategory value -> its (single) parent category. */
  categoryOf: Record<string, string>;
};

export function buildAttributeOptions(lines: SaleLineRow[], sel: AttributeSelection): AttributeOptions {
  const counts = {} as Record<AttributeFacetKey, [string, number][]>;

  for (const facet of ATTRIBUTE_FACETS) {
    const base = lines.filter((l) => lineMatches(l, sel, facet.key));
    const map = new Map<string, number>();
    for (const l of base) {
      const v = facet.get(l);
      map.set(v, (map.get(v) ?? 0) + 1);
    }
    // A currently-selected value stays listed even at 0 rows, so the user can
    // always see and remove their own picks — verbatim from FacetFilterBar.
    for (const v of sel[facet.key]) if (!map.has(v)) map.set(v, 0);
    counts[facet.key] = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }

  // Subcategories partition categories (verified live: zero subcategories span
  // more than one category), so a plain last-write map is lossless here.
  const categoryOf: Record<string, string> = {};
  for (const l of lines) {
    const sub = orDash(l.subcategory);
    if (sub !== UNCLASSIFIED) categoryOf[sub] = orDash(l.category);
  }

  return { counts, categoryOf };
}

/** Human summary of what's active, for a section's "Showing:" line. */
export function describeAttributeSelection(sel: AttributeSelection): string | null {
  const parts = ATTRIBUTE_FACETS.filter((f) => sel[f.key].length > 0).map((f) => {
    const chosen = sel[f.key];
    return `${f.label}: ${chosen.length === 1 ? chosen[0] : `${chosen.length} selected`}`;
  });
  return parts.length > 0 ? parts.join(" · ") : null;
}
