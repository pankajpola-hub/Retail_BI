/**
 * Pure aggregation helpers over sales.vw_stock_with_scheme rows (the live
 * stock snapshot joined to the scheme lookup — see migration 0024). Kept
 * separate from the page component so the grouping logic is easy to read
 * and adjust independently of layout.
 */

export type StockRow = {
  id: number;
  branch_name: string | null;
  season: string | null;
  gender: string | null;
  size_group: string | null;
  item_code: string;
  shade_name: string | null;
  size: string | null;
  closing_stock: number;
  is_eoss: boolean;
};

export type Gender = "FEMALE" | "MALE";
export type AgeSegment = "Baby" | "Kids";

export const GENDER_LABELS: Record<Gender, string> = { FEMALE: "Girls", MALE: "Boys" };

/**
 * The stock report's SIZE GROUP column has four real values (INFANTS,
 * TODDLERS, KIDS, YOUTH; verified live, no other values present). The "DC"
 * planning sheet the user described only has two age buckets, Baby and Kids.
 * Mapped here as: INFANTS -> Baby, TODDLERS -> Baby, KIDS -> Kids,
 * YOUTH -> Kids. TODDLERS was originally a flagged judgment call (it could
 * have gone into Kids instead, given the item-code convention's distinct
 * "TA" tag) — the user has since confirmed TODDLERS belongs in Baby, so this
 * is settled, not an open assumption.
 */
export const AGE_SEGMENT_MAP: Record<string, AgeSegment> = {
  INFANTS: "Baby",
  TODDLERS: "Baby",
  KIDS: "Kids",
  YOUTH: "Kids",
};

export function ageSegmentOf(sizeGroup: string | null): AgeSegment | null {
  if (!sizeGroup) return null;
  return AGE_SEGMENT_MAP[sizeGroup] ?? null;
}

export type FreshEossSplit = {
  fresh: number;
  eoss: number;
  total: number;
  eossPct: number;
  freshPct: number;
};

function split(rows: StockRow[]): FreshEossSplit {
  let fresh = 0;
  let eoss = 0;
  for (const r of rows) {
    if (r.is_eoss) eoss += r.closing_stock;
    else fresh += r.closing_stock;
  }
  const total = fresh + eoss;
  // freshPct derived as the complement of eossPct (not recomputed from fresh
  // independently) so the two always sum to exactly 100% of the row's stock,
  // with no floating-point drift between them.
  const eossPct = total > 0 ? (eoss / total) * 100 : 0;
  return { fresh, eoss, total, eossPct, freshPct: total > 0 ? 100 - eossPct : 0 };
}

export type DcBlock = { gender: Gender; ageSegment: AgeSegment; label: string } & FreshEossSplit;

export function buildDcMatrix(rows: StockRow[]): DcBlock[] {
  const genders: Gender[] = ["FEMALE", "MALE"];
  const ageSegments: AgeSegment[] = ["Baby", "Kids"];
  const blocks: DcBlock[] = [];
  for (const gender of genders) {
    for (const ageSegment of ageSegments) {
      const matching = rows.filter((r) => r.gender === gender && ageSegmentOf(r.size_group) === ageSegment);
      blocks.push({
        gender,
        ageSegment,
        label: `${GENDER_LABELS[gender]} ${ageSegment === "Baby" ? "Baby" : "Kids"}`,
        ...split(matching),
      });
    }
  }
  return blocks;
}

export type NibmSummary = { gender: Gender; label: string; total: number; sharePct: number };

export function buildNibmSummary(dcBlocks: DcBlock[]): NibmSummary[] {
  const totals = new Map<Gender, number>();
  for (const b of dcBlocks) totals.set(b.gender, (totals.get(b.gender) ?? 0) + b.total);
  const grandTotal = [...totals.values()].reduce((a, b) => a + b, 0);
  return (["FEMALE", "MALE"] as Gender[]).map((gender) => ({
    gender,
    label: GENDER_LABELS[gender],
    total: totals.get(gender) ?? 0,
    sharePct: grandTotal > 0 ? ((totals.get(gender) ?? 0) / grandTotal) * 100 : 0,
  }));
}

/**
 * Admin-editable base display capacity, one row per store x gender x
 * age-segment (4 per store — see migration 0026_stock_display_capacity.sql).
 * This is the number that used to have no home at all: the DC matrix above
 * (buildDcMatrix) is an ACTUAL Fresh/EOSS stock split, unrelated to any
 * planned capacity figure — there was no base-capacity number anywhere in
 * this codebase before 0026, hardcoded or otherwise. buildCapacityPlan below
 * is what turns the stored base_capacity into the planned 35/65 Fresh/EOSS
 * split with a 110% buffer, per store.
 */
export type CapacityRow = {
  store_id: string;
  gender: Gender;
  age_segment: AgeSegment;
  base_capacity: number;
  buffer_pct: number | null;
  fresh_pct: number | null;
  updated_by: string | null;
  updated_at: string | null;
};

/**
 * App-wide fallback used whenever a row's buffer_pct/fresh_pct is NULL —
 * i.e. no admin has customized that block yet (migration 0031). Expressed as
 * percentages (110 = 110%, 35 = 35%) to match what the admin types into the
 * edit form and what's stored in the DB, unlike the old CAPACITY_* constants
 * below which were fractions (1.1, 0.35, 0.65).
 */
export const DEFAULT_BUFFER_PCT = 110;
export const DEFAULT_FRESH_PCT = 35;

export type CapacityBlock = {
  gender: Gender;
  ageSegment: AgeSegment;
  label: string;
  baseCapacity: number;
  /** Effective buffer/fresh/eoss %, i.e. the row's override if set, else DEFAULT_BUFFER_PCT/DEFAULT_FRESH_PCT — used for the buffered/fresh/eoss math below. */
  bufferPct: number;
  freshPct: number;
  eossPct: number;
  /** Raw stored override (null if this block has never been customized) — what the edit form should show/blank, as opposed to bufferPct/freshPct above which always have a value. */
  bufferPctOverride: number | null;
  freshPctOverride: number | null;
  bufferedCapacity: number;
  freshCapacity: number;
  eossCapacity: number;
  updatedBy: string | null;
  updatedAt: string | null;
};

/** Rows should already be filtered to a single store before calling this. */
export function buildCapacityPlan(rows: CapacityRow[]): CapacityBlock[] {
  const genders: Gender[] = ["FEMALE", "MALE"];
  const ageSegments: AgeSegment[] = ["Baby", "Kids"];
  const blocks: CapacityBlock[] = [];
  for (const gender of genders) {
    for (const ageSegment of ageSegments) {
      const row = rows.find((r) => r.gender === gender && r.age_segment === ageSegment);
      const baseCapacity = row?.base_capacity ?? 0;
      const bufferPct = row?.buffer_pct ?? DEFAULT_BUFFER_PCT;
      const freshPct = row?.fresh_pct ?? DEFAULT_FRESH_PCT;
      // eossPct is always the complement of freshPct (never stored/recomputed
      // independently) so the two always sum to exactly 100%, same pattern
      // split() uses for the live actual Fresh/EOSS numbers above.
      const eossPct = 100 - freshPct;
      // Rounded here, once, rather than left as floats and rounded only at
      // display time (fmt()) — every consumer (the per-block cards AND the
      // store-level Total row) now reads the same whole numbers, so the
      // totals always equal what you'd get adding up the numbers on screen.
      // eossCapacity is buffered - fresh (not its own independent round) so
      // Fresh + EOSS always equals Buffered exactly, per block.
      const bufferedCapacity = Math.round(baseCapacity * (bufferPct / 100));
      const freshCapacity = Math.round(bufferedCapacity * (freshPct / 100));
      const eossCapacity = bufferedCapacity - freshCapacity;
      blocks.push({
        gender,
        ageSegment,
        label: `${GENDER_LABELS[gender]} ${ageSegment}`,
        baseCapacity,
        bufferPct,
        freshPct,
        eossPct,
        bufferPctOverride: row?.buffer_pct ?? null,
        freshPctOverride: row?.fresh_pct ?? null,
        bufferedCapacity,
        freshCapacity,
        eossCapacity,
        updatedBy: row?.updated_by ?? null,
        updatedAt: row?.updated_at ?? null,
      });
    }
  }
  return blocks;
}

export type CapacityTotals = {
  baseCapacity: number;
  bufferedCapacity: number;
  freshCapacity: number;
  eossCapacity: number;
};

/** Sums a store's 4 CapacityBlocks into one "Total base display capacity" rollup line. */
export function buildCapacityTotals(blocks: CapacityBlock[]): CapacityTotals {
  return blocks.reduce(
    (acc, b) => ({
      baseCapacity: acc.baseCapacity + b.baseCapacity,
      bufferedCapacity: acc.bufferedCapacity + b.bufferedCapacity,
      freshCapacity: acc.freshCapacity + b.freshCapacity,
      eossCapacity: acc.eossCapacity + b.eossCapacity,
    }),
    { baseCapacity: 0, bufferedCapacity: 0, freshCapacity: 0, eossCapacity: 0 }
  );
}

export type CapacityNibmSummary = { gender: Gender; label: string; total: number; sharePct: number };

/** Girls-vs-Boys share of total PLANNED (buffered) capacity — the capacity-plan analogue of buildNibmSummary. */
export function buildCapacityNibmSummary(blocks: CapacityBlock[]): CapacityNibmSummary[] {
  const totals = new Map<Gender, number>();
  for (const b of blocks) totals.set(b.gender, (totals.get(b.gender) ?? 0) + b.bufferedCapacity);
  const grandTotal = [...totals.values()].reduce((a, b) => a + b, 0);
  return (["FEMALE", "MALE"] as Gender[]).map((gender) => ({
    gender,
    label: GENDER_LABELS[gender],
    total: totals.get(gender) ?? 0,
    sharePct: grandTotal > 0 ? ((totals.get(gender) ?? 0) / grandTotal) * 100 : 0,
  }));
}

export type CapacityStatus = { label: string; className: string };

/**
 * Short / Excess / On target / Not set — the one column a store manager
 * actually needs: "does what's on the floor match what was planned?"
 * `hasPlan` false only when nobody has ever entered a base capacity for
 * this segment — flagged distinctly from "Excess" (which would otherwise
 * misleadingly claim the ENTIRE stock count as "excess" against a planned
 * figure of zero). Extracted verbatim from
 * app/(stock-details)/stock-details/page.tsx (2026-08-20) so the
 * Workspace's stock_vs_capacity_table calls the same function.
 */
export function capacityStatus(actual: number, planned: number, hasPlan: boolean): CapacityStatus {
  const fmt = (n: number) => Math.round(n).toLocaleString("en-IN");
  if (!hasPlan) return { label: "Capacity not set", className: "text-ink-3" };
  const diff = actual - planned;
  if (diff === 0) return { label: "On target", className: "text-good" };
  if (diff < 0) return { label: `Short by ${fmt(-diff)}`, className: "text-crit" };
  return { label: `Excess by ${fmt(diff)}`, className: "text-warn" };
}

type SplitCells = { target: number; actual: number; status: CapacityStatus };

function splitCells(target: number, actual: number, hasPlan: boolean): SplitCells {
  return { target, actual, status: capacityStatus(actual, target, hasPlan) };
}

export type CapacityGridRow = {
  storeId: string;
  storeName: string;
  segment: string;
  baseCapacity: number;
  bufferPct: number;
  freshTarget: number;
  freshActual: number;
  freshStatusLabel: string;
  freshStatusClass: string;
  eossTarget: number;
  eossActual: number;
  eossStatusLabel: string;
  eossStatusClass: string;
};

/**
 * One flat row per store × segment (Girls/Boys x Baby/Kids), across every
 * store passed in — feeds StockVsCapacityGrid.tsx (AG Grid) on
 * `/stock-details` and the Workspace's stock_vs_capacity_table alike.
 */
export function buildCapacityGridRows<S extends { store_id: string; store_name: string }>(
  stores: S[],
  blocksByStore: (s: S) => CapacityBlock[],
  actualBlocksByStore: (s: S) => DcBlock[]
): CapacityGridRow[] {
  const out: CapacityGridRow[] = [];
  for (const s of stores) {
    const blocks = blocksByStore(s);
    const actualBlocks = actualBlocksByStore(s);
    for (const b of blocks) {
      const actual = actualBlocks.find((a) => a.gender === b.gender && a.ageSegment === b.ageSegment);
      const hasPlan = b.baseCapacity > 0;
      const fresh = splitCells(b.freshCapacity, actual?.fresh ?? 0, hasPlan);
      const eoss = splitCells(b.eossCapacity, actual?.eoss ?? 0, hasPlan);
      out.push({
        storeId: s.store_id,
        storeName: s.store_name,
        segment: b.label,
        baseCapacity: b.baseCapacity,
        bufferPct: b.bufferPct,
        freshTarget: fresh.target,
        freshActual: fresh.actual,
        freshStatusLabel: fresh.status.label,
        freshStatusClass: fresh.status.className,
        eossTarget: eoss.target,
        eossActual: eoss.actual,
        eossStatusLabel: eoss.status.label,
        eossStatusClass: eoss.status.className,
      });
    }
  }
  return out;
}

export type GroupedBreakdown = { key: string; label: string } & FreshEossSplit;

/** Generic "group by X, split by gender within each group" used for season/color/size/size-group. */
export function groupByGenderAnd(
  rows: StockRow[],
  keyFn: (r: StockRow) => string | null,
  gender: Gender
): GroupedBreakdown[] {
  const byKey = new Map<string, StockRow[]>();
  for (const r of rows) {
    if (r.gender !== gender) continue;
    const key = keyFn(r) ?? "(blank)";
    const list = byKey.get(key) ?? [];
    list.push(r);
    byKey.set(key, list);
  }
  return [...byKey.entries()]
    .map(([key, list]) => ({ key, label: key, ...split(list) }))
    .sort((a, b) => b.total - a.total);
}
