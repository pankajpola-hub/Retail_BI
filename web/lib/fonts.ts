import { Newsreader, IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";

/**
 * Real typographic identity, 2026-08-15 — fixes a bug found during the UI
 * critique pass: globals.css's --font-serif was aliased to the exact same
 * system-UI stack as --font-sans, so every heading styled `font-serif`
 * across 18 files silently rendered as plain system text. globals.css's
 * own header comment says the token system was "carried over verbatim
 * from the screen mockups" — the mockups clearly intended a real serif/
 * sans pairing (why else name a token --font-serif), it just never got
 * wired to an actual serif font.
 *
 * next/font/google self-hosts these at build time (no runtime Google
 * Fonts request, works fine in this all-local dev stack) and defines the
 * CSS custom property named in `variable` directly — chosen to match the
 * EXISTING token names (--font-serif/--font-sans/--font-mono) exactly, so
 * every component and tailwind.config.ts's fontFamily mapping that
 * already reference var(--font-serif) etc. pick this up with zero other
 * changes. globals.css's old hardcoded system-stack fallbacks for these
 * three were removed — this is now the only definition.
 *
 * Pairing: Newsreader (display serif, headings) + IBM Plex Sans (body/UI)
 * + IBM Plex Mono (tabular numbers, discount %/currency figures
 * throughout). Chosen deliberately against the generic AI-default set
 * (Inter, Space Grotesk, a warm-cream/serif-display cliché) — IBM Plex is
 * a real enterprise-product typeface family (used by IBM's own products),
 * Newsreader is an editorial serif with genuine character at heading
 * sizes without reading as decorative.
 */
export const fontSerif = Newsreader({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-serif",
  display: "swap",
});

export const fontSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});

export const fontMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});
