"use client";
import { useMemo, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef } from "ag-grid-community";
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-quartz.css";
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
        cellStyle: (p) =>
          p.value === "CLEAN"
            ? { color: "var(--good, #2f7d5d)", fontWeight: 400 }
            : { color: "var(--bad, #a8402f)", fontWeight: 600 },
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
          className="min-w-[240px] rounded-md border border-border-strong bg-surface px-3 py-2 text-[13.5px] text-ink"
        />
        <label className="flex items-center gap-2 text-[13px] text-ink-2">
          <input type="checkbox" checked={onlyExceptions} onChange={(e) => setOnlyExceptions(e.target.checked)} />
          Only exceptions
        </label>
        <span className="font-mono text-[12px] text-ink-3">
          {data.length.toLocaleString("en-IN")} rows
        </span>
      </div>
      <div className="ag-theme-quartz" style={{ height: 620, width: "100%" }}>
        <AgGridReact<ReconLine>
          rowData={data}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          quickFilterText={quick}
          pagination
          paginationPageSize={100}
          animateRows
        />
      </div>
    </div>
  );
}
