"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronRight, ChevronDown, TrendingUp, TrendingDown } from "lucide-react";
import type { ColDef, ICellRendererParams, RowStyle } from "ag-grid-community";
import { DataGrid } from "@/components/ui/DataGrid";
import type { HierarchyRow } from "@/lib/saleSummary/hierarchy";

const PCT = (n: number | null) => (n === null ? "—" : `${n.toFixed(1)}%`);

/** Same signed discount/markup convention every table on this page uses (see aggregate.ts's ChannelSalesKpis.discountPct doc). */
function DiscountCell({ value }: { value: number | null }) {
  if (value === null) return <span className="font-mono text-ink-3">—</span>;
  return <span className="font-mono">{value < 0 ? `${Math.abs(value).toFixed(1)}% markup` : `${value.toFixed(1)}%`}</span>;
}

/** Growth% cell — trend glyph + colour, same ChangeCell convention PeriodSalesFacetedTable.tsx already establishes (never colour alone). "no baseline" (new/discontinued channel, or comparison off) reads as a plain dash, not a misleading 0%. */
function GrowthCell({ value, hasBaseline }: { value: number | null; hasBaseline: boolean }) {
  if (!hasBaseline) return <span className="text-ink-3">—</span>;
  if (value === null) return <span className="font-mono text-ink-3">0.0%</span>;
  const up = value >= 0;
  return (
    <span className={`inline-flex items-center gap-1 font-mono ${up ? "text-good" : "text-crit"}`}>
      {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      {up ? "+" : ""}
      {value.toFixed(1)}%
    </span>
  );
}

const LEVEL_ROW_STYLE: Record<0 | 1 | 2, RowStyle> = {
  0: { background: "var(--surface-2)", fontWeight: 700, borderTop: "2px solid var(--line)" },
  1: { background: "var(--surface-2)", fontWeight: 600 },
  2: {},
};

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/**
 * The 3-level Channel Model -> Channel Type -> Channel Name drill-down table
 * — replaces the old flat "Channel Type breakdown" table + separate "Top
 * parties" search (2026-08-31 redesign). Model and Type rows are always
 * shown (a manageable ~17 rows, matching the pivot-table screenshot this
 * was modeled on); a Type's Channel Name rows only render once that Type is
 * expanded.
 *
 * WHY NOT FacetFilterBar's buildGroupedRows/GroupHeaderRow: that primitive
 * (used by PeriodSalesFacetedTable/ProductAttributeSalesTable) always
 * renders every leaf row with synthetic header rows interleaved — it has no
 * concept of a header row carrying its own aggregated qty/gross/net (its
 * GroupHeaderRow is label+count only, with a SEPARATE subtotal row inserted
 * after the children), and no collapsed/expanded STATE at all, since every
 * caller so far wanted every row always visible. Neither fits this table:
 * the ask is specifically for the Model/Type row ITSELF to double as the
 * subtotal (so collapsed = ~17 rows total, not ~17 headers + ~17 subtotals
 * + 73 hidden leaves), with real show/hide state per Type. What IS reused
 * from the established convention: DataGrid for rendering/virtualization,
 * the level-based indent + colSpan-free label-column pattern those two
 * tables use for their own group headers, and — most importantly — the
 * "every ratio is recomputed from summed parts, never averaged" rule
 * (lib/saleSummary/hierarchy.ts's discountPctOf), which this table follows
 * exactly like they do.
 *
 * Expand/collapse animation: DataGrid's animateRows stays on (its default)
 * so AG Grid's own row-insert/remove transition plays when a Type's leaf
 * rows are added to/removed from rowData — a CSS-level transition, not a
 * hand-rolled height animation, and disabled outright when the OS/browser
 * requests prefers-reduced-motion.
 */
export function HierarchyTable({
  rows,
  forceExpandAll,
  emptyLabel,
}: {
  rows: HierarchyRow[];
  /** True while the page's search box has text — every Type auto-expands so a search result isn't hidden behind a collapsed row the user has no reason to know to click. Doesn't overwrite the user's own manual expand/collapse picks; those come back once the search is cleared. */
  forceExpandAll: boolean;
  emptyLabel: string;
}) {
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set());
  const reducedMotion = useReducedMotion();

  function toggleType(id: string) {
    setExpandedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const visibleRows = useMemo(
    () =>
      rows.filter((r) => {
        if (r.level !== 2) return true;
        const parentTypeId = `type:${r.channelModel} ${r.channelType}`;
        return forceExpandAll || expandedTypes.has(parentTypeId);
      }),
    [rows, expandedTypes, forceExpandAll]
  );

  const columnDefs = useMemo<ColDef<HierarchyRow>[]>(
    () => [
      {
        field: "label",
        headerName: "Channel Model / Type / Name",
        flex: 2,
        sortable: false,
        cellRenderer: (p: ICellRendererParams<HierarchyRow>) => {
          const row = p.data;
          if (!row) return null;
          const canExpand = row.level === 1 && row.childCount > 0;
          const isExpanded = forceExpandAll || expandedTypes.has(row.id);
          return (
            <div
              className={`flex h-full items-center gap-1.5 ${canExpand ? "cursor-pointer" : ""}`}
              style={{ paddingLeft: row.level * 18 }}
              onClick={canExpand ? () => toggleType(row.id) : undefined}
            >
              {canExpand ? (
                isExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-3" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-3" />
                )
              ) : (
                <span className="inline-block w-3.5 shrink-0" />
              )}
              <span className={row.level === 0 ? "font-semibold" : row.level === 1 ? "font-medium" : "text-ink-2"}>{row.label}</span>
              {row.level < 2 && <span className="font-mono text-[11px] font-normal text-ink-3">({row.childCount})</span>}
            </div>
          );
        },
      },
      { field: "qty", headerName: "Qty", flex: 0.7, sortable: true, cellClass: "text-right font-mono", headerClass: "text-right", valueFormatter: (p) => Math.round(p.value).toLocaleString("en-IN") },
      { field: "gross", headerName: "Gross", flex: 0.9, sortable: true, cellClass: "text-right font-mono", headerClass: "text-right", valueFormatter: (p) => `₹${Math.round(p.value).toLocaleString("en-IN")}` },
      { field: "net", headerName: "Net", flex: 0.9, sortable: true, cellClass: "text-right font-mono", headerClass: "text-right", valueFormatter: (p) => `₹${Math.round(p.value).toLocaleString("en-IN")}` },
      {
        field: "discountPct",
        headerName: "Discount / Markup %",
        flex: 0.9,
        sortable: true,
        cellClass: "text-right",
        headerClass: "text-right",
        cellRenderer: (p: ICellRendererParams<HierarchyRow, number | null>) => <DiscountCell value={p.value ?? null} />,
      },
      {
        field: "growthPct",
        headerName: "Growth",
        flex: 0.8,
        sortable: true,
        cellClass: "text-right",
        headerClass: "text-right",
        cellRenderer: (p: ICellRendererParams<HierarchyRow, number | null>) => (
          <GrowthCell value={p.value ?? null} hasBaseline={p.data?.hasComparisonBaseline ?? false} />
        ),
      },
    ],
    [expandedTypes, forceExpandAll]
  );

  return (
    <DataGrid<HierarchyRow>
      animateRows={!reducedMotion}
      rowData={visibleRows}
      columnDefs={columnDefs}
      getRowStyle={(p) => LEVEL_ROW_STYLE[(p.data?.level ?? 2) as 0 | 1 | 2]}
      getRowId={(p) => p.data.id}
      heightPx={Math.min(640, Math.max(160, 46 + visibleRows.length * 36))}
      overlayNoRowsTemplate={emptyLabel}
    />
  );
}
