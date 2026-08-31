/**
 * Indian abbreviated currency formatting — Thousand / Lakh / Crore — for
 * /sale-summary only (2026-08-31 redesign, task 4). The rest of the app's
 * INR()/formatCurrency-style helpers (grep for those before assuming this
 * is the only one) print plain en-IN comma grouping (₹12,34,567); this page
 * is an executive/CEO-facing dashboard where the ask was specifically
 * abbreviated units for readability at a glance (₹2.21 Cr, not
 * ₹2,21,00,000). Deliberately scoped to this page/folder rather than
 * changing the app-wide formatter — that's a separate, already-flagged-but-
 * undecided consolidation question (docs/audit/D-frontend.md, D-12), out of
 * scope here.
 */

/** ₹ amount -> "₹2.21 Cr" / "₹45.6 L" / "₹12,345" (plain comma grouping below 1 lakh). Sign-preserving. */
export function fmtInrAbbrev(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_00_00_000) return `${sign}₹${(abs / 1_00_00_000).toFixed(2)} Cr`;
  if (abs >= 1_00_000) return `${sign}₹${(abs / 1_00_000).toFixed(1)} L`;
  return `${sign}₹${Math.round(abs).toLocaleString("en-IN")}`;
}

/** Plain integer count, en-IN grouped — used for Qty/Bills-style whole-number columns that should NOT get the Cr/L treatment. */
export function fmtCount(n: number): string {
  return Math.round(n).toLocaleString("en-IN");
}
