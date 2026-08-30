"use client";

import { useMemo, useState } from "react";
import type { ColDef, ValueFormatterParams, CellClassParams, RowStyle } from "ag-grid-community";
import { DataGrid } from "@/components/ui/DataGrid";
import {
  FacetFilterBar,
  applyFacetFilter,
  emptyFilterState,
  type FacetDef,
  type AdvField,
  type FacetFilterState,
} from "@/components/ui/FacetFilterBar";
import type { StockStatusRow, StockStatusAlert } from "@/lib/stockStatus/aggregate";
import type { ChannelSummary } from "@/lib/inventory/model";

const PAGE_KEY = "sales_stock_status";

const MISMATCH_ROW_STYLE: RowStyle = { background: "var(--crit-soft)" };

const INR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/**
 * Big executive-summary tile. Optionally a toggle for the "Go-Live Status"
 * facet (clicking Live/Can Go Live/Not Live sets that one facet value on or
 * off) - the numbers ARE the drill-down, so a boss scanning this doesn't
 * need to separately learn the facet bar underneath to act on what they see.
 */
function KpiTile({
  num,
  label,
  tone,
  active,
  onClick,
}: {
  num: number | string;
  label: string;
  tone?: "good" | "warn" | "crit";
  active?: boolean;
  onClick?: () => void;
}) {
  const toneClass = tone === "good" ? "text-good" : tone === "warn" ? "text-warn" : tone === "crit" ? "text-crit" : "text-ink";
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={`rounded-lg border px-5 py-3.5 text-left transition-colors ${
        active ? "border-accent bg-accent-soft" : "border-line bg-surface hover:bg-surface-2"
      } ${onClick ? "cursor-pointer" : ""}`}
    >
      <div className={`text-2xl font-serif ${toneClass}`}>{num}</div>
      <div className="mt-0.5 text-[11.5px] font-medium uppercase tracking-wide text-ink-3">{label}</div>
    </Comp>
  );
}

/**
 * One row per registered sales channel (lib/inventory/model.ts's CHANNELS),
 * not just Shopify - an inactive channel (no working inventory adapter yet,
 * e.g. Myntra/Ajio/Amazon pending a Uniware inventory integration) renders
 * as an explicit "Not connected" row rather than a fabricated 0, so nobody
 * mistakes "we don't measure this yet" for "this channel has zero stock."
 */
function ChannelComparisonTable({ summaries }: { summaries: ChannelSummary[] }) {
  return (
    <div className="mb-6 overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[720px] text-[13px]">
        <thead>
          <tr className="border-b border-line bg-surface-2 text-left text-[11px] uppercase tracking-wide text-ink-3">
            <th className="px-4 py-2.5">Channel</th>
            <th className="px-4 py-2.5 text-right">Live SKUs</th>
            <th className="px-4 py-2.5 text-right">Sellable Units</th>
            <th className="px-4 py-2.5 text-right">WH Eligible</th>
            <th className="px-4 py-2.5 text-right">Missing / Can Go Live</th>
            <th className="px-4 py-2.5 text-right">Mismatch Units</th>
            <th className="px-4 py-2.5 text-right">Availability %</th>
          </tr>
        </thead>
        <tbody>
          {summaries.map((s) => (
            <tr key={s.channelId} className={`border-b border-line-soft last:border-0 ${s.active ? "" : "opacity-50"}`}>
              <td className="px-4 py-2.5 font-medium">{s.channelName}</td>
              {s.active ? (
                <>
                  <td className="px-4 py-2.5 text-right font-mono">{s.liveSkus.toLocaleString("en-IN")}</td>
                  <td className="px-4 py-2.5 text-right font-mono">{s.sellableUnits.toLocaleString("en-IN")}</td>
                  <td className="px-4 py-2.5 text-right font-mono">{s.whEligibleUnits.toLocaleString("en-IN")}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-warn">{s.missingUnits.toLocaleString("en-IN")}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-crit">{s.mismatchUnits.toLocaleString("en-IN")}</td>
                  <td className="px-4 py-2.5 text-right font-mono">{s.availabilityPct === null ? "—" : `${s.availabilityPct.toFixed(1)}%`}</td>
                </>
              ) : (
                <td colSpan={6} className="px-4 py-2.5 text-ink-3">
                  Not connected — no live inventory feed for this channel yet
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * WH Stock -> Catalogued (style listed on Shopify) -> Catalogued (exact
 * colour listed) -> Live (SOH > 0). Deliberately NOT the reference
 * screenshot's 5-stage "Eligible/Allocated" funnel - this codebase has no
 * eligibility/allocation RULE anywhere (no "this style is Shopify-only"
 * flag), so those two stages would be invented. These four stages are each
 * a real, derivable fact from the WH-vs-Shopify comparison itself.
 */
function FunnelChart({
  stages,
}: {
  stages: { label: string; units: number }[];
}) {
  const max = Math.max(1, ...stages.map((s) => s.units));
  return (
    <div className="flex flex-col gap-2">
      {stages.map((s, i) => {
        const pctOfMax = (s.units / max) * 100;
        const pctOfPrev = i === 0 ? 100 : stages[i - 1]!.units > 0 ? (s.units / stages[i - 1]!.units) * 100 : 0;
        return (
          <div key={s.label} className="flex items-center gap-3">
            <div className="w-40 shrink-0 text-[12px] text-ink-2">{s.label}</div>
            <div className="h-6 flex-1 rounded bg-surface-2">
              <div
                className="h-6 rounded bg-accent transition-all"
                style={{ width: `${Math.max(pctOfMax, 2)}%` }}
                title={`${s.units.toLocaleString("en-IN")} units`}
              />
            </div>
            <div className="w-20 shrink-0 text-right font-mono text-[12.5px] text-ink">{s.units.toLocaleString("en-IN")}</div>
            <div className="w-14 shrink-0 text-right text-[11px] text-ink-3">{i === 0 ? "" : `${pctOfPrev.toFixed(0)}%`}</div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Simple SVG ring, not a charting library - three real, mutually exclusive
 * slices of total WH stock: live on Shopify, sitting unallocated (can go
 * live), and "not live" (neither side has meaningful stock / data quality
 * gaps). Other channels are named in the legend as unmeasured rather than
 * folded into any slice, so the ring never implies stock exists somewhere
 * it hasn't actually been counted.
 */
function DistributionRing({ segments }: { segments: { label: string; value: number; color: string }[] }) {
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  const R = 60;
  const CIRC = 2 * Math.PI * R;
  let offset = 0;
  return (
    <div className="flex items-center gap-6">
      <svg viewBox="0 0 160 160" className="h-40 w-40 shrink-0" role="img" aria-label="WH stock distribution">
        <g transform="rotate(-90 80 80)">
          <circle cx="80" cy="80" r={R} fill="none" stroke="var(--surface-2)" strokeWidth="20" />
          {total > 0 &&
            segments.map((seg) => {
              const frac = seg.value / total;
              const dash = frac * CIRC;
              const el = (
                <circle
                  key={seg.label}
                  cx="80"
                  cy="80"
                  r={R}
                  fill="none"
                  stroke={seg.color}
                  strokeWidth="20"
                  strokeDasharray={`${dash} ${CIRC - dash}`}
                  strokeDashoffset={-offset}
                />
              );
              offset += dash;
              return el;
            })}
        </g>
        <text x="80" y="76" textAnchor="middle" className="fill-ink text-[20px] font-serif">
          {total.toLocaleString("en-IN")}
        </text>
        <text x="80" y="94" textAnchor="middle" className="fill-current text-ink-3 text-[9px] uppercase tracking-wide">
          Total WH stock
        </text>
      </svg>
      <div className="flex flex-col gap-1.5 text-[12.5px]">
        {segments.map((seg) => (
          <div key={seg.label} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: seg.color }} />
            <span className="text-ink-2">{seg.label}</span>
            <span className="ml-auto font-mono text-ink-3">
              {total > 0 ? `${((seg.value / total) * 100).toFixed(1)}%` : "—"} ({seg.value.toLocaleString("en-IN")})
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const SEVERITY_STYLE: Record<StockStatusAlert["severity"], { dot: string; text: string; label: string }> = {
  critical: { dot: "bg-crit", text: "text-crit", label: "Critical" },
  attention: { dot: "bg-warn", text: "text-warn", label: "Attention" },
  healthy: { dot: "bg-good", text: "text-good", label: "Healthy" },
};

/** Real, computed alerts (see lib/stockStatus/aggregate.ts) - each one clickable straight into the same facet filter the detail table below uses. */
function AlertsPanel({ alerts, onDrill }: { alerts: StockStatusAlert[]; onDrill: (a: StockStatusAlert) => void }) {
  return (
    <div className="divide-y divide-line-soft rounded-lg border border-line">
      {alerts.map((a) => {
        const sev = SEVERITY_STYLE[a.severity];
        const clickable = a.filterFacet !== null;
        return (
          <button
            key={a.id}
            type="button"
            disabled={!clickable}
            onClick={() => clickable && onDrill(a)}
            className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-[12.5px] ${
              clickable ? "cursor-pointer hover:bg-surface-2" : "cursor-default"
            }`}
          >
            <span className={`h-2 w-2 shrink-0 rounded-full ${sev.dot}`} />
            <span className="text-ink-2">{a.label}</span>
            <span className={`ml-auto font-mono font-semibold ${sev.text}`}>{a.count.toLocaleString("en-IN")}</span>
            <span className={`w-16 text-right text-[10.5px] uppercase tracking-wide ${sev.text}`}>{sev.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

/** Data-freshness strip - management must know whether a discrepancy is a real mismatch or just a stale WH upload. Shopify's side is always live (fetched this request), so it never goes stale by construction. */
function SyncBanner({ whLastSyncedAt, shopifyFetchedAt }: { whLastSyncedAt: string | null; shopifyFetchedAt: string }) {
  const whStaleHours = whLastSyncedAt ? (Date.now() - new Date(whLastSyncedAt).getTime()) / 3_600_000 : Infinity;
  const whStale = whStaleHours > 24;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-4 rounded-lg border border-line bg-surface px-4 py-2.5 text-[12px]">
      <span className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-good" /> Shopify API — Live, fetched {timeAgo(shopifyFetchedAt)}
      </span>
      <span className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${whStale ? "bg-warn" : "bg-good"}`} /> Warehouse ERP — last upload {timeAgo(whLastSyncedAt)}
      </span>
      {whStale && (
        <span className="text-warn">
          Inventory comparison may be stale — the WH stock file hasn&apos;t been re-uploaded in over 24h (see Data Upload).
        </span>
      )}
    </div>
  );
}

/**
 * WH stock vs Shopify SOH, per style/colour - ported from the Shopify
 * image-uploader project's Stock Status page
 * (D:\Py\Shopify image uploader\server\static\index.html, the "Stock
 * Status (WH vs Shopify)" section), same FacetFilterBar engine this app
 * already shares with every other faceted table here.
 *
 * The KPI row up top is the "boss view" - Live / Can Go Live / Not Live /
 * mismatches, each clickable straight into the filtered detail table below
 * it, so a five-second glance answers "what's live, what isn't, and what's
 * sitting in the warehouse ready to go live" without reading the grid.
 */
export function StockStatusFacetedTable({
  rows,
  channelSummaries,
  totalWhStockValue,
  canGoLiveValue,
  alerts,
  funnel,
  whLastSyncedAt,
  shopifyFetchedAt,
}: {
  rows: StockStatusRow[];
  channelSummaries: ChannelSummary[];
  totalWhStockValue: number;
  canGoLiveValue: number;
  alerts: StockStatusAlert[];
  funnel: { whStock: number; whStockCataloguedStyle: number; whStockCataloguedColour: number; liveShopifySoh: number };
  whLastSyncedAt: string | null;
  shopifyFetchedAt: string;
}) {
  const [state, setState] = useState<FacetFilterState>(emptyFilterState);

  const facets = useMemo<FacetDef<StockStatusRow>[]>(
    () => [
      { key: "goLiveStatus", label: "Go-Live Status", get: (r) => r.goLiveStatus },
      { key: "colour", label: "Colour", get: (r) => r.colour },
      { key: "status", label: "Shopify Status", get: (r) => r.status || "Unknown" },
      { key: "match", label: "Match", get: (r) => (r.match ? "Match" : "Mismatch") },
      { key: "onShopify", label: "On Shopify", get: (r) => (r.onShopify ? "Yes" : "No") },
      { key: "whHasData", label: "WH Data", get: (r) => (r.whHasData ? "Has WH data" : "No WH data") },
      // Item-master attributes (raw_logic.item_master, already joined onto
      // vw_stock_with_scheme) - same attribute set lib/replenishment/mix.ts's
      // attribute-wise views (Color/Size/Gender/Season/MRP) offer.
      { key: "season", label: "Season", get: (r) => r.season },
      { key: "gender", label: "Gender", get: (r) => r.gender },
      { key: "sizeGroup", label: "Size Group", get: (r) => r.sizeGroup },
      { key: "subcategory", label: "Subcategory", get: (r) => r.subcategory },
      { key: "marketSegment", label: "Market Segment", get: (r) => r.marketSegment },
    ],
    []
  );

  const advFields = useMemo<AdvField<StockStatusRow>[]>(
    () => [
      { key: "style", label: "Style No.", get: (r) => r.style },
      { key: "title", label: "Product Title", get: (r) => r.title },
      { key: "colour", label: "Colour", get: (r) => r.colour },
      { key: "whStock", label: "WH Stock", get: (r) => r.whStock, numeric: true },
      { key: "shopifySoh", label: "Shopify SOH", get: (r) => r.shopifySoh, numeric: true },
      { key: "diff", label: "Difference (WH - Shopify)", get: (r) => r.diff, numeric: true },
      { key: "season", label: "Season", get: (r) => r.season },
      { key: "gender", label: "Gender", get: (r) => r.gender },
      { key: "sizeGroup", label: "Size Group", get: (r) => r.sizeGroup },
      { key: "subcategory", label: "Subcategory", get: (r) => r.subcategory },
      { key: "marketSegment", label: "Market Segment", get: (r) => r.marketSegment },
      { key: "mrp", label: "MRP", get: (r) => r.mrp, numeric: true },
    ],
    []
  );

  const filtered = useMemo(() => applyFacetFilter(rows, facets, advFields, state), [rows, facets, advFields, state]);

  // Counted over ALL rows (not `filtered`) - the KPI row is the fixed
  // top-level summary the facet bar drills down FROM, so it shouldn't
  // shrink just because someone is mid-filter on something else. Each tile
  // toggles the one facet value it represents, same click-to-filter the
  // facet panel itself offers.
  const liveCount = useMemo(() => rows.filter((r) => r.goLiveStatus === "Live").length, [rows]);
  const canGoLiveCount = useMemo(() => rows.filter((r) => r.goLiveStatus === "Can Go Live").length, [rows]);
  const notLiveCount = useMemo(() => rows.filter((r) => r.goLiveStatus === "Not Live").length, [rows]);
  const mismatchCount = useMemo(() => rows.filter((r) => !r.match).length, [rows]);
  const totalWh = useMemo(() => rows.reduce((s, r) => s + (r.whHasData ? r.whStock : 0), 0), [rows]);
  const totalShopify = useMemo(() => rows.reduce((s, r) => s + (r.shopifyHasData ? r.shopifySoh : 0), 0), [rows]);

  function setSingleFacet(key: string, value: string) {
    setState({ ...state, facets: { ...state.facets, [key]: [value] } });
  }
  function toggleGoLiveStatus(value: string) {
    const cur = new Set(state.facets.goLiveStatus ?? []);
    if (cur.has(value)) cur.delete(value);
    else {
      cur.clear(); // one status at a time from the KPI row - a multi-select is the facet panel's job, not the headline tiles'
      cur.add(value);
    }
    setState({ ...state, facets: { ...state.facets, goLiveStatus: [...cur] } });
  }
  const activeGoLive = new Set(state.facets.goLiveStatus ?? []);

  const columnDefs = useMemo<ColDef<StockStatusRow>[]>(
    () => [
      { field: "style", headerName: "Style", flex: 0.7, sortable: true, cellClass: "font-semibold" },
      { field: "title", headerName: "Product Title", flex: 1.5, sortable: true },
      { field: "colour", headerName: "Colour", flex: 0.8, sortable: true },
      {
        field: "goLiveStatus",
        headerName: "Go-Live Status",
        flex: 0.9,
        sortable: true,
        cellClass: (p: CellClassParams<StockStatusRow, string>) =>
          p.value === "Live" ? "text-good font-semibold" : p.value === "Can Go Live" ? "text-warn font-semibold" : "text-ink-3",
      },
      {
        field: "whStock",
        headerName: "WH Stock",
        flex: 0.8,
        sortable: true,
        cellClass: "text-right font-mono",
        headerClass: "text-right",
        valueFormatter: (p: ValueFormatterParams<StockStatusRow, number>) => (p.data && !p.data.whHasData ? "—" : String(p.value)),
      },
      {
        field: "shopifySoh",
        headerName: "Shopify SOH",
        flex: 0.9,
        sortable: true,
        cellClass: "text-right font-mono",
        headerClass: "text-right",
        valueFormatter: (p: ValueFormatterParams<StockStatusRow, number>) => (p.data && !p.data.shopifyHasData ? "—" : String(p.value)),
      },
      {
        field: "diff",
        headerName: "Difference",
        flex: 0.8,
        sortable: true,
        cellClass: (p: CellClassParams<StockStatusRow, number>) =>
          `text-right font-mono ${(p.value ?? 0) > 0 ? "text-crit" : (p.value ?? 0) < 0 ? "text-warn" : ""}`,
        headerClass: "text-right",
        valueFormatter: (p: ValueFormatterParams<StockStatusRow, number>) => ((p.value ?? 0) > 0 ? `+${p.value}` : String(p.value)),
      },
      {
        field: "match",
        headerName: "Match?",
        flex: 0.6,
        sortable: true,
        cellClass: (p: CellClassParams<StockStatusRow, boolean>) => (p.value ? "text-good font-semibold" : "text-crit font-semibold"),
        valueFormatter: (p: ValueFormatterParams<StockStatusRow, boolean>) => (p.value ? "Yes" : "No"),
      },
      { field: "status", headerName: "Shopify Status", flex: 1, sortable: true },
      { field: "season", headerName: "Season", flex: 0.7, sortable: true },
      { field: "gender", headerName: "Gender", flex: 0.6, sortable: true },
      { field: "sizeGroup", headerName: "Size Group", flex: 0.7, sortable: true },
      { field: "subcategory", headerName: "Subcategory", flex: 0.8, sortable: true },
      { field: "marketSegment", headerName: "Market Segment", flex: 0.8, sortable: true },
      {
        field: "mrp",
        headerName: "MRP",
        flex: 0.6,
        sortable: true,
        cellClass: "text-right font-mono",
        headerClass: "text-right",
        valueFormatter: (p: ValueFormatterParams<StockStatusRow, number | null>) => (p.value == null ? "—" : `₹${p.value}`),
      },
    ],
    []
  );

  const distributionSegments = useMemo(() => {
    const live = rows.reduce((s, r) => s + (r.goLiveStatus === "Live" ? r.whStock : 0), 0);
    const canGoLive = rows.reduce((s, r) => s + (r.goLiveStatus === "Can Go Live" ? r.whStock : 0), 0);
    const notLive = rows.reduce((s, r) => s + (r.goLiveStatus === "Not Live" && r.whHasData ? r.whStock : 0), 0);
    return [
      { label: "Live on Shopify", value: live, color: "var(--good)" },
      { label: "Can go live (unallocated)", value: canGoLive, color: "var(--warn)" },
      { label: "Not live", value: notLive, color: "var(--line)" },
    ];
  }, [rows]);

  return (
    <>
      <SyncBanner whLastSyncedAt={whLastSyncedAt} shopifyFetchedAt={shopifyFetchedAt} />

      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <KpiTile num={liveCount} label="Live on Shopify" tone="good" active={activeGoLive.has("Live")} onClick={() => toggleGoLiveStatus("Live")} />
        <KpiTile
          num={canGoLiveCount}
          label="Can go live now"
          tone="warn"
          active={activeGoLive.has("Can Go Live")}
          onClick={() => toggleGoLiveStatus("Can Go Live")}
        />
        <KpiTile num={notLiveCount} label="Not live" active={activeGoLive.has("Not Live")} onClick={() => toggleGoLiveStatus("Not Live")} />
        <KpiTile num={mismatchCount} label="Stock mismatches" tone={mismatchCount > 0 ? "crit" : undefined} />
        <KpiTile num={totalWh.toLocaleString("en-IN")} label="Total WH stock" />
        <KpiTile num={totalShopify.toLocaleString("en-IN")} label="Total Shopify SOH" />
        <KpiTile num={INR(totalWhStockValue)} label="WH stock value (MRP)" />
        <KpiTile num={INR(canGoLiveValue)} label="Can-go-live opportunity (MRP)" tone="warn" />
      </div>
      <p className="mb-4 text-[11.5px] text-ink-3">
        Shopify is the only live channel wired up here today - Myntra/Ajio/other marketplace inventory isn&apos;t
        fed into this comparison yet (their sales are tracked on the Ecomm page, but not live stock). All value
        figures are MRP-based (no distinct cost/selling price is captured in the warehouse data) - treat them as a
        ceiling, not an estimate of realizable revenue.
      </p>

      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Channel-wise Stock Comparison</h3>
      <ChannelComparisonTable summaries={channelSummaries} />

      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-line p-4">
          <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Inventory Funnel</h3>
          <FunnelChart
            stages={[
              { label: "WH Stock", units: funnel.whStock },
              { label: "Style on Shopify", units: funnel.whStockCataloguedStyle },
              { label: "Colour on Shopify", units: funnel.whStockCataloguedColour },
              { label: "Live (SOH > 0)", units: funnel.liveShopifySoh },
            ]}
          />
        </div>
        <div className="rounded-lg border border-line p-4">
          <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-ink-3">WH Stock Distribution</h3>
          <DistributionRing segments={distributionSegments} />
        </div>
      </div>

      <div className="mb-6">
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Stock Health</h3>
        <AlertsPanel
          alerts={alerts}
          onDrill={(a) => {
            if (a.filterFacet) setSingleFacet(a.filterFacet, a.filterValue!);
          }}
        />
      </div>

      <FacetFilterBar pageKey={PAGE_KEY} rows={rows} facets={facets} advFields={advFields} groupByOptions={[]} state={state} onChange={setState} />
      <div className="mb-2 text-[12px] text-ink-3">
        {filtered.length === rows.length ? `${filtered.length} rows` : `${filtered.length} of ${rows.length} rows`}
      </div>
      <DataGrid<StockStatusRow>
        animateRows={false}
        rowData={filtered}
        columnDefs={columnDefs}
        heightPx={Math.min(640, Math.max(160, 46 + filtered.length * 38))}
        getRowStyle={(p) => (p.data && !p.data.match ? MISMATCH_ROW_STYLE : undefined)}
        getRowId={(p) => `${p.data.style}::${p.data.colour}`}
        overlayNoRowsTemplate="No rows match these filters."
      />
    </>
  );
}
