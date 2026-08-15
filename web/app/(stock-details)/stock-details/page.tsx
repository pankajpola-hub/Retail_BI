import { createClient } from "@/lib/data/client";
import { requirePageAccess } from "@/lib/auth/roles";
import { MultiSelectFilter } from "@/components/ui/StoreFilter";
import { CapacityEditorCard } from "./capacity-editor";
import {
  GENDER_LABELS,
  buildDcMatrix,
  buildNibmSummary,
  buildCapacityPlan,
  buildCapacityNibmSummary,
  groupByGenderAnd,
  type Gender,
  type StockRow,
  type CapacityRow,
  type CapacityBlock,
  type DcBlock,
} from "@/lib/stockDetails/aggregate";

export const dynamic = "force-dynamic";

const GENDERS: Gender[] = ["FEMALE", "MALE"];

type StoreRow = { store_id: string; store_name: string; branch_name_erp: string };

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-IN");
}

function pct(n: number): string {
  return `${n.toFixed(1)}%`;
}

/**
 * Short / Excess / On target / Not set — the one column a store manager
 * actually needs from this whole page: "does what's on the floor match what
 * was planned?" `hasPlan` is false only when nobody has ever entered a base
 * capacity for this segment — flagged distinctly from "Excess" (which would
 * otherwise misleadingly claim the ENTIRE stock count as "excess" against a
 * planned figure of zero, when the real issue is just that no plan exists).
 */
function capacityStatus(actual: number, planned: number, hasPlan: boolean): { label: string; className: string } {
  if (!hasPlan) return { label: "Capacity not set", className: "text-ink-3" };
  const diff = actual - planned;
  if (diff === 0) return { label: "On target", className: "text-good" };
  if (diff < 0) return { label: `Short by ${fmt(-diff)}`, className: "text-crit" };
  return { label: `Excess by ${fmt(diff)}`, className: "text-warn" };
}

/**
 * The main "what should I do" table on this page: for one store, each
 * planned segment (Girls/Boys x Baby/Kids) next to the CURRENT actual stock
 * for that same segment, with a plain-language status. Replaces what used to
 * be a sentence buried inside each capacity-editor block ("Current actual
 * (live stock) 899 (F 331 / E 568) vs planned 344 — Excess by 555") — same
 * numbers, but as a table a store manager can scan in one glance instead of
 * parsing prose four times per store.
 */
/** One row's worth of Fresh OR EOSS numbers — target (planned), actual, status. */
type SplitCells = { target: number; actual: number; status: { label: string; className: string } };

function splitCells(target: number, actual: number, hasPlan: boolean): SplitCells {
  return { target, actual, status: capacityStatus(actual, target, hasPlan) };
}

function StockVsCapacityTable({
  storeName,
  storeId,
  blocks,
  actualBlocks,
}: {
  storeName: string;
  storeId: string;
  blocks: CapacityBlock[];
  actualBlocks: DcBlock[];
}) {
  const rows = blocks.map((b) => {
    const actual = actualBlocks.find((a) => a.gender === b.gender && a.ageSegment === b.ageSegment);
    const hasPlan = b.baseCapacity > 0;
    return {
      block: b,
      fresh: splitCells(b.freshCapacity, actual?.fresh ?? 0, hasPlan),
      eoss: splitCells(b.eossCapacity, actual?.eoss ?? 0, hasPlan),
    };
  });
  const totalBase = blocks.reduce((s, b) => s + b.baseCapacity, 0);
  const totalHasPlan = blocks.some((b) => b.baseCapacity > 0);
  const totalFresh = splitCells(
    blocks.reduce((s, b) => s + b.freshCapacity, 0),
    rows.reduce((s, r) => s + r.fresh.actual, 0),
    totalHasPlan
  );
  const totalEoss = splitCells(
    blocks.reduce((s, b) => s + b.eossCapacity, 0),
    rows.reduce((s, r) => s + r.eoss.actual, 0),
    totalHasPlan
  );

  return (
    <div className="border border-line-soft">
      <div className="flex items-baseline justify-between bg-surface-2 px-3 py-2">
        <span className="text-sm font-semibold">{storeName}</span>
        <span className="text-[11px] text-ink-3">{storeId}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-[12.5px]">
          <thead>
            <tr className="border-b border-line-soft text-left text-[10px] uppercase tracking-wide text-ink-3">
              <th className="px-3 py-2" rowSpan={2}>
                Segment
              </th>
              <th className="px-3 py-2 text-right" rowSpan={2}>
                Base capacity
              </th>
              <th className="px-3 py-2 text-right" rowSpan={2}>
                Buffer %
              </th>
              <th className="border-l border-line-soft px-3 py-1.5 text-center" colSpan={3}>
                Fresh
              </th>
              <th className="border-l border-line-soft px-3 py-1.5 text-center" colSpan={3}>
                EOSS
              </th>
            </tr>
            <tr className="border-b border-line-soft text-left text-[10px] uppercase tracking-wide text-ink-3">
              <th className="border-l border-line-soft px-3 py-1.5 text-right">Planned</th>
              <th className="px-3 py-1.5 text-right">Current stock</th>
              <th className="px-3 py-1.5 text-right">Status</th>
              <th className="border-l border-line-soft px-3 py-1.5 text-right">Planned</th>
              <th className="px-3 py-1.5 text-right">Current stock</th>
              <th className="px-3 py-1.5 text-right">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ block, fresh, eoss }) => (
              <tr key={`${block.gender}-${block.ageSegment}`} className="border-b border-line-soft last:border-0">
                <td className="px-3 py-2 font-medium text-ink-2">{block.label}</td>
                <td className="px-3 py-2 text-right font-mono text-ink-2">{fmt(block.baseCapacity)}</td>
                <td className="px-3 py-2 text-right font-mono text-ink-2">{block.bufferPct}%</td>
                <td className="border-l border-line-soft px-3 py-2 text-right font-mono text-ink-2">{fmt(fresh.target)}</td>
                <td className="px-3 py-2 text-right font-mono text-ink-2">{fmt(fresh.actual)}</td>
                <td className={`px-3 py-2 text-right font-semibold ${fresh.status.className}`}>{fresh.status.label}</td>
                <td className="border-l border-line-soft px-3 py-2 text-right font-mono text-ink-2">{fmt(eoss.target)}</td>
                <td className="px-3 py-2 text-right font-mono text-ink-2">{fmt(eoss.actual)}</td>
                <td className={`px-3 py-2 text-right font-semibold ${eoss.status.className}`}>{eoss.status.label}</td>
              </tr>
            ))}
            <tr className="border-t-2 border-line bg-surface-2 font-semibold">
              <td className="px-3 py-2">Total</td>
              <td className="px-3 py-2 text-right font-mono">{fmt(totalBase)}</td>
              <td className="px-3 py-2 text-right"></td>
              <td className="border-l border-line-soft px-3 py-2 text-right font-mono">{fmt(totalFresh.target)}</td>
              <td className="px-3 py-2 text-right font-mono">{fmt(totalFresh.actual)}</td>
              <td className={`px-3 py-2 text-right ${totalFresh.status.className}`}>{totalFresh.status.label}</td>
              <td className="border-l border-line-soft px-3 py-2 text-right font-mono">{fmt(totalEoss.target)}</td>
              <td className="px-3 py-2 text-right font-mono">{fmt(totalEoss.actual)}</td>
              <td className={`px-3 py-2 text-right ${totalEoss.status.className}`}>{totalEoss.status.label}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Girls vs Boys share of a total, shown as two big numbers side by side. */
function GenderSplitCard({ title, note, data }: { title: string; note: string; data: { gender: Gender; label: string; total: number; sharePct: number }[] }) {
  return (
    <div className="border border-line-soft p-4">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">{title}</span>
      <p className="mt-0.5 text-[11px] text-ink-3">{note}</p>
      <div className="mt-2 flex gap-6">
        {data.map((n) => (
          <div key={n.gender}>
            <div className="text-lg font-serif">{pct(n.sharePct)}</div>
            <div className="text-[12px] text-ink-3">
              {n.label} ({fmt(n.total)} units)
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default async function StockDetailsPage({
  searchParams,
}: {
  searchParams: { store?: string };
}) {
  // Independent re-check of the layout's requirePageAccess (perf pass: was
  // a plain requireRole with a hardcoded role list that could silently
  // diverge from the layout's per-user-override-aware gate — e.g. a role
  // granted access to this page via an override at the layout would still
  // get redirected away here by a hardcoded list that doesn't know about
  // the override). Now both layers use the same override-aware check, and
  // — since requirePageAccess/requireRole share the same underlying
  // per-request-cached profile/store-id resolution — this "independent
  // re-check" costs nothing extra over the layout's own call.
  const user = await requirePageAccess("stock-details");
  const canEditCapacity = user.role === "ho_admin" || user.role === "super_admin";

  const supabase = await createClient();

  const { data: storesData } = await supabase
    .schema("core")
    .from<StoreRow>("stores")
    .select("store_id, store_name, branch_name_erp")
    .order("store_id");
  // BO-004 (Phoenix Palassio, Lucknow) is discontinued — kept visible only on
  // /network for historical reference, hidden from every other store filter.
  const storeList = (storesData ?? []).filter((s) => s.store_id !== "BO-004");

  const storeLabels = Object.fromEntries(storeList.map((s) => [s.store_id, s.store_name]));
  const selectedStoreIds = (searchParams.store ?? "")
    .split(",")
    .filter((id) => storeList.some((s) => s.store_id === id));
  const selectedBranchNames = storeList
    .filter((s) => selectedStoreIds.includes(s.store_id))
    .map((s) => s.branch_name_erp);
  // Every section on this page (capacity cards, the comparison table, both
  // gender-split boxes) now scopes to exactly this list — no section is
  // silently "all stores" while its neighbors are filtered, which used to
  // read as a bug (the Planned gender-split box previously always showed
  // every store's numbers regardless of the filter above it).
  const storesInView = selectedStoreIds.length > 0 ? storeList.filter((s) => selectedStoreIds.includes(s.store_id)) : storeList;

  // Pushed down to SQL when a store filter is active: the capacity cards
  // below only ever render the SELECTED store(s), so there's no reason to
  // pull every OTHER store's ~1,500-2,500 stock lines over the network just
  // to filter them out in JS afterward. This was the actual cause behind
  // "picking a store feels like it's stuck on the old one" — the unfiltered
  // fetch (up to 20,000 rows, all stores) genuinely took several seconds
  // over the connection to the self-hosted backend, so stale content stayed
  // on screen well past a quick glance; the filter itself was always
  // applying correctly once the fetch finished.
  // Always constrained to known retail branches (core.stores), never "every
  // branch_name present in the stock file" — a non-retail branch like a
  // warehouse (added to the stock upload for replenishment purposes, not
  // display-floor purposes) has no business counting toward "current stock"
  // here. This was a real, confirmed bug: adding a "WAREHOUSE - PUNE -
  // DHAYARI" branch to the stock report inflated this page's Girls total
  // from 4,310 to 40,448 units — warehouse reserve stock silently mixed into
  // retail display-floor totals. Also incidentally fixes a second bug: the
  // unfiltered query was hitting the .limit(20000) cap exactly (silently
  // truncating), which a warehouse branch's bulk stock made much likelier to
  // hit — narrowing to only the known store branches keeps the row count
  // sane regardless of how many non-retail branches get added to future
  // uploads. Warehouse stock has its own home: /replenishment.
  const knownBranchNames = storeList.map((s) => s.branch_name_erp);
  const branchFilter = selectedBranchNames.length > 0 ? selectedBranchNames : knownBranchNames;
  const { data: rawRows, error } = await supabase
    .schema("sales")
    .from<StockRow>("vw_stock_with_scheme")
    .select("id, branch_name, season, gender, size_group, item_code, shade_name, size, closing_stock, is_eoss")
    .in("branch_name", branchFilter)
    .limit(20000);

  // Gender-filtered. Store-filtered too now when a filter is active (see
  // above) — safe because the capacity cards below only render the
  // currently-selected store(s), so they never need an unselected store's
  // rows.
  const allGenderRows = (rawRows ?? []).filter((r) => r.gender === "FEMALE" || r.gender === "MALE");

  const rows = allGenderRows.filter(
    (r) => selectedBranchNames.length === 0 || (r.branch_name !== null && selectedBranchNames.includes(r.branch_name))
  );

  // Base display capacity (migration 0026) — independent of whether a stock
  // snapshot has been uploaded, so this is fetched and rendered regardless
  // of the `rows.length` early-return below.
  const { data: capacityData } = await supabase
    .schema("ops")
    .from<CapacityRow>("stock_display_capacity")
    .select("store_id, gender, age_segment, base_capacity, buffer_pct, fresh_pct, updated_by, updated_at");
  const capacityRows = capacityData ?? [];

  const editorIds = [...new Set(capacityRows.map((r) => r.updated_by).filter((id): id is string => !!id))];
  const { data: editorProfiles } =
    editorIds.length > 0
      ? await supabase
          .schema("core")
          .from<{ user_id: string; full_name: string }>("profiles")
          .select("user_id, full_name")
          .in("user_id", editorIds)
      : { data: [] as { user_id: string; full_name: string }[] };
  const namesByUserId = Object.fromEntries((editorProfiles ?? []).map((p) => [p.user_id, p.full_name]));

  const plannedGenderSplit = buildCapacityNibmSummary(
    storesInView.flatMap((s) => buildCapacityPlan(capacityRows.filter((r) => r.store_id === s.store_id)))
  );

  const capacitySection = (
    <>
      <h2 className="mt-8 text-[11px] font-semibold uppercase tracking-wide text-ink-2">
        Planned display capacity — set base capacity per store
      </h2>
      <p className="mt-1 max-w-3xl text-[12.5px] text-ink-3">
        Admin-set base capacity per store, per gender x age-segment. {canEditCapacity
          ? "Edit and Save below — HO Admin / Super Admin only."
          : "View only — ask an HO Admin / Super Admin to change these."}{" "}
        Buffered (planned) = base × Buffer%; Fresh/EOSS = buffered × Fresh% / (100 − Fresh%). Buffer% and Fresh%
        default to 110% / 35% but can be overridden per block below. How this compares against what&apos;s actually
        on the floor right now is in the table above, not repeated here.
      </p>
      <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-2">
        {storesInView.map((s) => (
          <CapacityEditorCard
            key={s.store_id}
            storeId={s.store_id}
            storeName={s.store_name}
            blocks={buildCapacityPlan(capacityRows.filter((r) => r.store_id === s.store_id))}
            namesByUserId={namesByUserId}
            canEdit={canEditCapacity}
          />
        ))}
      </div>
    </>
  );

  if (!rows.length) {
    return (
      <main className="py-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="font-serif text-2xl">Stock Details</h1>
          {storeList.length > 0 && (
            <MultiSelectFilter
              paramName="store"
              options={storeList.map((s) => s.store_id)}
              labels={storeLabels}
              selected={selectedStoreIds}
              label="Store"
              allLabel="All stores"
            />
          )}
        </div>
        <p className="mt-3 text-sm text-ink-3">
          {selectedBranchNames.length > 0
            ? "No stock for the selected store(s) in the current snapshot."
            : "No stock snapshot loaded yet. Upload and process a Stock report (and a Scheme report, for the Fresh/EOSS split) from "}
          {selectedBranchNames.length === 0 && (
            <a href="/data-upload" className="underline">
              Data Upload
            </a>
          )}
          {error ? ` — query error: ${error.message}` : selectedBranchNames.length > 0 ? "." : ""}
        </p>

        {capacitySection}
      </main>
    );
  }

  const dcBlocks = buildDcMatrix(rows);
  const nibm = buildNibmSummary(dcBlocks);

  return (
    <main className="py-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-serif text-2xl">Stock Details</h1>
        {storeList.length > 0 && (
          <MultiSelectFilter
            paramName="store"
            options={storeList.map((s) => s.store_id)}
            labels={storeLabels}
            selected={selectedStoreIds}
            label="Store"
            allLabel="All stores"
          />
        )}
      </div>
      <p className="mt-1 max-w-3xl text-[12.5px] text-ink-3">
        Live equivalent of the Display Capacity planning sheet — computed from the current stock snapshot
        (uploaded via Data Upload) cross-referenced against the scheme lookup, not a planned 35/65 split.
        &quot;Fresh&quot; = no active discount scheme on the item; &quot;EOSS&quot; = a scheme discounting
        50% or more (same rule as the Targets page&apos;s Fresh/Discounted split). {fmt(rows.length)} stock
        lines in the current snapshot.
      </p>

      {/* ---------------- Current stock vs planned capacity — the main comparison ---------------- */}
      <h2 className="mt-8 text-[11px] font-semibold uppercase tracking-wide text-ink-2">
        Current stock vs planned display capacity
      </h2>
      <p className="mt-1 max-w-3xl text-[12.5px] text-ink-3">
        For each store and segment: how much display capacity is planned, how much stock is actually on hand
        right now, and whether that&apos;s short of, in line with, or in excess of plan.
      </p>
      <div className="mt-3 flex flex-col gap-4">
        {storesInView.map((s) => (
          <StockVsCapacityTable
            key={s.store_id}
            storeId={s.store_id}
            storeName={s.store_name}
            blocks={buildCapacityPlan(capacityRows.filter((r) => r.store_id === s.store_id))}
            actualBlocks={buildDcMatrix(allGenderRows.filter((r) => r.branch_name === s.branch_name_erp))}
          />
        ))}
      </div>

      {/* ---------------- gender split — planned vs current, side by side ---------------- */}
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {storesInView.length > 1 && (
          <GenderSplitCard
            title="Gender split — planned capacity"
            note={`Girls vs Boys share of total planned (buffered) capacity, ${selectedStoreIds.length > 0 ? "selected store(s)" : "all stores"}.`}
            data={plannedGenderSplit}
          />
        )}
        <GenderSplitCard
          title="Gender split — current stock"
          note={`Girls vs Boys share of total stock on hand, ${selectedStoreIds.length > 0 ? "selected store(s)" : "all stores"}.`}
          data={nibm}
        />
      </div>

      {capacitySection}

      {/* ---------------- generic breakdown tables ---------------- */}
      <BreakdownSection title="Season-wise stock" rows={rows} keyFn={(r) => r.season} />
      <BreakdownSection title="Size-group-wise stock" rows={rows} keyFn={(r) => r.size_group} />
      <BreakdownSection title="Color-wise stock (top 15 shades per gender)" rows={rows} keyFn={(r) => r.shade_name} topN={15} />
      <BreakdownSection title="Size-wise stock" rows={rows} keyFn={(r) => r.size} />
    </main>
  );
}

function BreakdownSection({
  title,
  rows,
  keyFn,
  topN,
}: {
  title: string;
  rows: StockRow[];
  keyFn: (r: StockRow) => string | null;
  topN?: number;
}) {
  return (
    <div className="mt-8">
      <h2 className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">{title}</h2>
      <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {GENDERS.map((gender) => {
          const grouped = groupByGenderAnd(rows, keyFn, gender);
          const shown = topN ? grouped.slice(0, topN) : grouped;
          // Subtotal always reflects the FULL group (every season/size/color),
          // not just the "top 15" slice shown below it — the top-15 color
          // table's own rows can't add up to it, by design, and that's fine;
          // this is "how much stock exists in total," the rows are "where."
          const totalFresh = grouped.reduce((s, g) => s + g.fresh, 0);
          const totalEoss = grouped.reduce((s, g) => s + g.eoss, 0);
          const totalUnits = totalFresh + totalEoss;
          const totalFreshPct = totalUnits > 0 ? (totalFresh / totalUnits) * 100 : 0;
          const totalEossPct = totalUnits > 0 ? 100 - totalFreshPct : 0;
          return (
            <div key={gender} className="overflow-x-auto border border-line-soft">
              <table className="w-full min-w-[420px] text-[12.5px]">
                <thead>
                  <tr className="border-b border-line-soft bg-surface-2 text-left text-[10px] uppercase tracking-wide text-ink-3">
                    <th className="px-2 py-2">{GENDER_LABELS[gender]}</th>
                    <th className="px-2 py-2 text-right">Units (Fresh / EOSS)</th>
                    <th className="px-2 py-2 text-right">Fresh% / EOSS%</th>
                  </tr>
                  <tr className="border-b-2 border-line bg-surface-2 text-left font-semibold">
                    <td className="px-2 py-1.5">Total</td>
                    <td className="px-2 py-1.5 text-right">
                      {fmt(totalUnits)}{" "}
                      <span className="font-normal text-ink-3">
                        ({fmt(totalFresh)} / {fmt(totalEoss)})
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      {pct(totalFreshPct)} /{" "}
                      <span className={totalEossPct >= 70 ? "text-crit" : ""}>{pct(totalEossPct)}</span>
                    </td>
                  </tr>
                </thead>
                <tbody>
                  {shown.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="px-2 py-2 text-ink-3">
                        No stock.
                      </td>
                    </tr>
                  ) : (
                    shown.map((g) => (
                      <tr key={g.key} className="border-b border-line-soft last:border-0">
                        <td className="px-2 py-1.5">{g.label}</td>
                        <td className="px-2 py-1.5 text-right">
                          {fmt(g.total)}{" "}
                          <span className="text-ink-3">
                            ({fmt(g.fresh)} / {fmt(g.eoss)})
                          </span>
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          {pct(g.freshPct)} /{" "}
                          <span className={g.eossPct >= 70 ? "text-crit" : ""}>{pct(g.eossPct)}</span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>
    </div>
  );
}
