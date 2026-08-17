import type { Config } from "tailwindcss";

// Colors are NOT duplicated here as hex values — every token below points at
// the CSS custom properties defined in app/globals.css, which is the single
// source of truth (and what already has light/dark variants worked out, the
// same token system used in the screen mockups). Change a color once, in one
// file, in either place.
// Tremor color scale + safelist below is the standard block @tremor/react's
// own install docs specify verbatim (unchanged across the v2/v3 line) — it
// is Tremor's OWN internal color system (used for its default chart series
// colors etc.), kept deliberately separate from the app's own --accent/etc.
// token system above. Nothing here overrides or renames an existing app
// token; Tailwind deep-merges theme.extend.colors, so both coexist.
const tremorSafelistColors = [
  "slate", "gray", "zinc", "neutral", "stone", "red", "orange", "amber", "yellow",
  "lime", "green", "emerald", "teal", "cyan", "sky", "blue", "indigo", "violet",
  "purple", "fuchsia", "pink", "rose",
];
const tremorShades = "50|100|200|300|400|500|600|700|800|900|950";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./node_modules/@tremor/**/*.{js,ts,jsx,tsx}",
  ],
  safelist: [
    { pattern: new RegExp(`^bg-(${tremorSafelistColors.join("|")})-(${tremorShades})$`), variants: ["hover", "ui-selected"] },
    { pattern: new RegExp(`^text-(${tremorSafelistColors.join("|")})-(${tremorShades})$`), variants: ["hover", "ui-selected"] },
    { pattern: new RegExp(`^border-(${tremorSafelistColors.join("|")})-(${tremorShades})$`), variants: ["hover", "ui-selected"] },
    { pattern: new RegExp(`^ring-(${tremorSafelistColors.join("|")})-(${tremorShades})$`) },
    { pattern: new RegExp(`^stroke-(${tremorSafelistColors.join("|")})-(${tremorShades})$`) },
    { pattern: new RegExp(`^fill-(${tremorSafelistColors.join("|")})-(${tremorShades})$`) },
  ],
  theme: {
    transparent: "transparent",
    current: "currentColor",
    extend: {
      colors: {
        tremor: {
          brand: { faint: "#eff6ff", muted: "#bfdbfe", subtle: "#60a5fa", DEFAULT: "#3b82f6", emphasis: "#1d4ed8", inverted: "#ffffff" },
          background: { muted: "#f9fafb", subtle: "#f3f4f6", DEFAULT: "#ffffff", emphasis: "#374151" },
          border: { DEFAULT: "#e5e7eb" },
          ring: { DEFAULT: "#e5e7eb" },
          content: { subtle: "#9ca3af", DEFAULT: "#6b7280", emphasis: "#374151", strong: "#111827", inverted: "#ffffff" },
        },
        "dark-tremor": {
          brand: { faint: "#0B1229", muted: "#172554", subtle: "#1e40af", DEFAULT: "#3b82f6", emphasis: "#60a5fa", inverted: "#030712" },
          background: { muted: "#131A2B", subtle: "#1f2937", DEFAULT: "#111827", emphasis: "#d1d5db" },
          border: { DEFAULT: "#1f2937" },
          ring: { DEFAULT: "#1f2937" },
          content: { subtle: "#4b5563", DEFAULT: "#6b7280", emphasis: "#e5e7eb", strong: "#f9fafb", inverted: "#000000" },
        },
        ground: "var(--ground)",
        surface: "var(--surface)",
        "surface-2": "var(--surface-2)",
        line: "var(--line)",
        "line-soft": "var(--line-soft)",
        ink: "var(--ink)",
        "ink-2": "var(--ink-2)",
        "ink-3": "var(--ink-3)",
        accent: "var(--accent)",
        "accent-soft": "var(--accent-soft)",
        "accent-ink": "var(--accent-ink)",
        good: "var(--good)",
        "good-soft": "var(--good-soft)",
        warn: "var(--warn)",
        "warn-soft": "var(--warn-soft)",
        crit: "var(--crit)",
        "crit-soft": "var(--crit-soft)",
        "sidebar-bg": "var(--sidebar-bg)",
        "sidebar-active-bg": "var(--sidebar-active-bg)",
        "sidebar-ink": "var(--sidebar-ink)",
        "sidebar-ink-active": "var(--sidebar-ink-active)",
        "topbar-bg": "var(--topbar-bg)",
        "topbar-ink": "var(--topbar-ink)",
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
        serif: ["var(--font-serif)"],
        mono: ["var(--font-mono)"],
      },
      boxShadow: {
        "tremor-input": "0 1px 2px 0 rgb(0 0 0 / 0.05)",
        "tremor-card": "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
        "tremor-dropdown": "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
        "dark-tremor-input": "0 1px 2px 0 rgb(0 0 0 / 0.05)",
        "dark-tremor-card": "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
        "dark-tremor-dropdown": "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
      },
      borderRadius: {
        "tremor-small": "0.375rem",
        "tremor-default": "0.5rem",
        "tremor-full": "9999px",
      },
      fontSize: {
        "tremor-label": ["0.75rem", { lineHeight: "1rem" }],
        "tremor-default": ["0.875rem", { lineHeight: "1.25rem" }],
        "tremor-title": ["1.125rem", { lineHeight: "1.75rem" }],
        "tremor-metric": ["1.875rem", { lineHeight: "2.25rem" }],
      },
    },
  },
  plugins: [require("@headlessui/tailwindcss"), require("tailwindcss-animate")],
};

export default config;
