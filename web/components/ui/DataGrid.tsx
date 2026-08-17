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
 * matching the light-mode token values). First real usage:
 * StoreLeagueDrilldown.tsx, replacing a plain &lt;table&gt; — gives real
 * column sort/resize and virtualized rows for free, which is the actual
 * point: Objective.md's Scale target flags that this app has no
 * virtualization anywhere, and a 100+ row table was always going to need
 * this eventually, not just the six-row fixture data today.
 */
const appQuartzTheme = themeQuartz.withParams({
  accentColor: "#008060",
  backgroundColor: "#ffffff",
  foregroundColor: "#1a1c1d",
  borderColor: "#e3e4e6",
  headerBackgroundColor: "#f6f6f7",
  headerTextColor: "#4a4e50",
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
