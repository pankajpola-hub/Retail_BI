"use client";

import { useEffect, useState } from "react";
import { AgGridReact, type AgGridReactProps } from "ag-grid-react";
import {
  ModuleRegistry,
  AllCommunityModule,
  themeQuartz,
  colorSchemeDark,
} from "ag-grid-community";

ModuleRegistry.registerModules([AllCommunityModule]);

/**
 * AG Grid Community, themed to match the app's existing design tokens
 * (Theming API params, not a bundled CSS theme file — see the plain hex
 * values below, which mirror app/globals.css's --accent/--surface/--ink/etc;
 * Tailwind CSS custom properties aren't readable from AG Grid's own
 * JS-evaluated theming system, so these are pinned literals — they must be
 * updated BY HAND whenever globals.css's palette changes, as they were for
 * the 2026-08-23 monochrome pass).
 *
 * There are THREE param objects, one per theme (light, dark, and the opt-in
 * electro), because dark mode is a real
 * shipped feature (app/layout.tsx's no-flash script and ThemeToggle both set
 * data-theme on <html>, and globals.css defines a full
 * :root[data-theme="dark"] palette) and a single pinned light theme made
 * every grid render a white table inside a dark page (audit finding D-03).
 * Each hex below is copied from the corresponding globals.css token, so the
 * light/dark pairs stay visually consistent with the rest of the app; keep
 * them in sync when the palette moves.
 *
 * First real usage: StoreLeagueDrilldown.tsx, replacing a plain &lt;table&gt;
 * — gives real column sort/resize and virtualized rows for free, which is the
 * actual point: Objective.md's Scale target flags that this app has no
 * virtualization anywhere, and a 100+ row table was always going to need this
 * eventually, not just the six-row fixture data today.
 */

// Shape/typography params are theme-independent — declared once so the two
// colour variants below can't silently drift apart.
const SHARED_PARAMS = {
  fontFamily: "inherit",
  fontSize: 13,
  headerFontSize: 11,
  borderRadius: 8,
  wrapperBorderRadius: 8,
  spacing: 6,
} as const;

const lightGridTheme = themeQuartz.withParams({
  // globals.css :root
  accentColor: "#111113", // --accent
  backgroundColor: "#ffffff", // --surface
  foregroundColor: "#111113", // --ink
  borderColor: "#e6e6e8", // --line-soft
  headerBackgroundColor: "#f1f1f2", // --surface-2
  headerTextColor: "#46464b", // --ink-2
  oddRowBackgroundColor: "#ffffff", // --surface
  ...SHARED_PARAMS,
});

// withPart(colorSchemeDark) first so AG Grid's own derived colours (menus,
// inputs, checkboxes, hover/selection tints) flip to their dark variants;
// withParams then pins the handful that must match our exact tokens.
const darkGridTheme = themeQuartz.withPart(colorSchemeDark).withParams({
  // globals.css :root[data-theme="dark"]
  accentColor: "#ffffff", // --accent
  backgroundColor: "#141416", // --surface
  foregroundColor: "#f2f2f4", // --ink
  borderColor: "#26262a", // --line-soft
  headerBackgroundColor: "#1c1c1f", // --surface-2
  headerTextColor: "#b0b0b8", // --ink-2
  oddRowBackgroundColor: "#141416", // --surface
  ...SHARED_PARAMS,
});

// Third variant for the opt-in "electro" theme (globals.css
// :root[data-theme="electro"]). Also built on colorSchemeDark, because the
// derived colours AG Grid computes for menus/inputs/checkboxes have to be
// dark-scheme here too; only the pinned params below differ from darkGridTheme.
//
// NOTE: accentColor is deliberately NOT the neon --accent (#a8ff3e). AG Grid
// spreads accentColor across selection fills, range highlights, checkboxes and
// the sort/filter indicators at once, and a full-saturation neon on all of
// those turns a dense table into a highlighter smear — the same readability
// concern that keeps the theme's hover-glow out of the grid entirely. A
// deep, desaturated lime keeps the family resemblance without the smear;
// --accent still shows up here as the header text colour.
const electroGridTheme = themeQuartz.withPart(colorSchemeDark).withParams({
  // globals.css :root[data-theme="electro"]
  accentColor: "#4d7a25", // --accent, darkened for large-area fills
  backgroundColor: "#0b0f0d", // --surface
  foregroundColor: "#e8f5ee", // --ink
  borderColor: "#18211d", // --line-soft
  headerBackgroundColor: "#121815", // --surface-2
  headerTextColor: "#a8ff3e", // --accent
  oddRowBackgroundColor: "#0b0f0d", // --surface
  ...SHARED_PARAMS,
});

/** The three themes globals.css defines. Mirrors ThemeToggle's own union. */
type GridTheme = "light" | "dark" | "electro";

const GRID_THEMES = {
  light: lightGridTheme,
  dark: darkGridTheme,
  electro: electroGridTheme,
} as const;

/**
 * Reads <html data-theme> reactively. Same shape as ThemeToggle's own read
 * (plain useState + useEffect, defaulting to light) so SSR output and the
 * pre-paint script agree; the MutationObserver is what ThemeToggle doesn't
 * need and this does — ThemeToggle OWNS the attribute so it already knows
 * when it changes, whereas a grid elsewhere in the tree has to observe it.
 *
 * Returns WHICH theme rather than a boolean (it was useIsDarkTheme until the
 * electro theme landed and made a two-state answer wrong). Anything
 * unrecognised — including the absent attribute, which is how light is
 * represented — falls back to light.
 */
function useGridTheme(): GridTheme {
  const [theme, setTheme] = useState<GridTheme>("light");

  useEffect(() => {
    const root = document.documentElement;
    const read = () => {
      const attr = root.getAttribute("data-theme");
      setTheme(attr === "dark" || attr === "electro" ? attr : "light");
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  return theme;
}

export function DataGrid<T>(props: AgGridReactProps<T> & { heightPx?: number }) {
  const { heightPx = 280, ...gridProps } = props;
  const theme = useGridTheme();
  return (
    <div style={{ height: heightPx, width: "100%" }}>
      <AgGridReact
        theme={GRID_THEMES[theme]}
        suppressCellFocus
        animateRows
        {...gridProps}
      />
    </div>
  );
}
