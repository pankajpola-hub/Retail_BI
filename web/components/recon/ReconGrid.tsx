"use client";
import { useMemo, useState } from "react";
import type { ColDef } from "ag-grid-community";
import { DataGrid } from "@/components/ui/DataGrid";
import type { ReconLine } from "@/lib/recon/queries";

const inr = (v: number | null) =>
  v == null ? "" : "₹" + Math.round(v).toLocaleString("en-IN");

export default function ReconGrid({ rows }: { rows: ReconLine[] }) {
  const [quick, setQuick] = useState("");
  const [onlyExceptions, setOnlyExceptions] = useState(false);

  const data = useMemo(
    () => (onlyExceptions ? rows.filter((r) => r.exception_code !== "CLEAN") : rows),
    [rows, onlyExceptions]
  );

  const columnDefs = useMemo<ColDef<ReconLine>[]>(
    () => [
      { field: "channel", headerName: "Channel", filter: true, width: 130 },
      { field: "order_code", headerName: "Order", filter: true, width: 150 },
      { field: "sku", headerName: "SKU", filter: true, width: 150 },
      { field: "status", headerName: "Status", filter: true, width: 120 },
      { field: "order_date", headerName: "Date", filter: true, width: 120 },
      { field: "mrp", headerName: "MRP", valueFormatter: (p) => inr(p.value), type: "rightAligned", width: 110 },
      { field: "selling_price", headerName: "Selling", valueFormatter: (p) => inr(p.value), type: "rightAligned", width: 110 },
      { field: "total_price", headerName: "Total", valueFormatter: (p) => inr(p.value), type: "rightAligned", width: 110 },
      { field: "discount", headerName: "Discount", valueFormatter: (p) => inr(p.value), type: "rightAligned", width: 110 },
      {
        field: "exception_code",
        headerName: "Exception",
        filter: true,
        width: 190,
        // App tokens (globals.css), theme-aware — not the CSS-file
        // fallback colors ("--bad" doesn't exist in this app; the good/crit
        // pair does and already flips for dark mode).
        cellStyle: (p) =>
          p.value === "CLEAN"
            ? { color: "var(--good)", fontWeight: 400 }
            : { color: "var(--crit)", fontWeight: 600 },
      },
      { field: "exception_severity", headerName: "Sev", filter: true, width: 100 },
      {
        field: "exception_amount",
        headerName: "Exposure",
        valueFormatter: (p) => (p.value ? inr(p.value) : ""),
        type: "rightAligned",
        width: 120,
      },
    ],
    []
  );

  const defaultColDef = useMemo<ColDef>(
    () => ({ sortable: true, resizable: true, filter: false }),
    []
  );

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <input
          placeholder="Search all columns…"
          value={quick}
          onChange={(e) => setQuick(e.target.value)}
          className="min-h-[36px] min-w-[240px] border border-line bg-surface px-3 py-1.5 text-[13px] text-ink"
        />
        <label className="flex items-center gap-2 text-[13px] text-ink-2">
          <input type="checkbox" checked={onlyExceptions} onChange={(e) => setOnlyExceptions(e.target.checked)} />
          Only exceptions
        </label>
        <span className="font-mono text-[12px] text-ink-3">
          {data.length.toLocaleString("en-IN")} rows
        </span>
      </div>
      <DataGrid<ReconLine>
        rowData={data}
        columnDefs={columnDefs}
        defaultColDef={defaultColDef}
        quickFilterText={quick}
        pagination
        paginationPageSize={100}
        animateRows
        heightPx={620}
        overlayNoRowsTemplate="No reconciliation lines match these filters."
      />
    </div>
  );
}
