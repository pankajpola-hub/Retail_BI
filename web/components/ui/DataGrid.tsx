"use client";

import { AgGridReact, type AgGridReactProps } from "ag-grid-react";
import { ModuleRegistry, AllCommunityModule, themeQuartz } from "ag-grid-community";

ModuleRegistry.registerModules([AllCommunityModule]);

/**
 * AG Grid Community, themed to match the app's existing design tokens
 * (Theming API params, not a bundled CSS theme file — see the plain hex
 * values below, which mirror app/globals.css's --accent/--surface/--ink/etc;
 * Tailwind CSS custom properties aren't readable from AG Grid's own
 * JS-evaluated theming system, so these are pinned literals, deliberately
 * matching the light-mode token values — they must be updated BY HAND
 * whenever globals.css's palette changes, as they were for the 2026-08-23
 * monochrome pass). First real usage:
 * StoreLeagueDrilldown.tsx, replacing a plain &lt;table&gt; — gives real
 * column sort/resize and virtualized rows for free, which is the actual
 * point: Objective.md's Scale target flags that this app has no
 * virtualization anywhere, and a 100+ row table was always going to need
 * this eventually, not just the six-row fixture data today.
 */
const appQuartzTheme = themeQuartz.withParams({
  accentColor: "#111113",
  backgroundColor: "#ffffff",
  foregroundColor: "#111113",
  borderColor: "#e6e6e8",
  headerBackgroundColor: "#f1f1f2",
  headerTextColor: "#46464b",
  oddRowBackgroundColor: "#ffffff",
  fontFamily: "inherit",
  fontSize: 13,
  headerFontSize: 11,
  borderRadius: 8,
  wrapperBorderRadius: 8,
  spacing: 6,
});

export function DataGrid<T>(props: AgGridReactProps<T> & { heightPx?: number }) {
  const { heightPx = 280, ...gridProps } = props;
  return (
    <div style={{ height: heightPx, width: "100%" }}>
      <AgGridReact theme={appQuartzTheme} suppressCellFocus animateRows {...gridProps} />
    </div>
  );
}
