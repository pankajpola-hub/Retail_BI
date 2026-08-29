# Marketplace Reconciliation — feature branch handoff

Branch: `feat/marketplace-recon` (isolated git worktree at `D:\Py\mrp-recon-wt`).
Built off `master`. **Additive only** — no existing page/logic rewritten.
Local `next build` passes; `/reconciliation` route compiles and is in the nav.

## What it adds

A new **Reconciliation** page under the ecomm vertical: line-level financial
audit of marketplace order data (Myntra, Shopify, Ajio, FirstCry, TataCliq),
with KPIs, a typed exception ledger, per-channel summary, and an AG Grid of every
order line (search + filter + "only exceptions").

## Files

**New**
- `server/db/migrations/0098_marketplace_recon.sql` — `ops.recon_lines` table + `ops.recon_channel_summary` / `ops.recon_exception_summary` views (grant pattern mirrors `ops.erp_report_uploads`).
- `server/db/migrations/0098_marketplace_recon_seed.sql` — 2,399 real lines from a Uniware export, **PII-free**, each classified into an exception at generate time.
- `web/lib/recon/queries.ts` — read helpers via the existing self-hosted client (`.schema("ops").from(...)`).
- `web/app/(ecomm)/reconciliation/page.tsx` — the page. Gated `requirePageAccess("ecomm")`; inherits `(ecomm)/layout.tsx` (AppShell + role gate).
- `web/components/recon/ReconGrid.tsx` — AG Grid client component.

**Edited (additive, small)**
- `web/components/ui/AppShell.tsx` — one line added to `NAV_LINKS`.
- `web/lib/i18n/translations.ts` — `navReconciliation` key (type + 3 locales).
- `web/package.json` — `ag-grid-community` + `ag-grid-react`.

## To ship

1. **DB** (against the live Postgres, your call): run `0098_marketplace_recon.sql`,
   then `0098_marketplace_recon_seed.sql`, then `NOTIFY pgrst, 'reload schema';`
   (the seed file already ends with that NOTIFY).
2. `npm install` in `web/` (pulls AG Grid).
3. Review the branch, merge to `master`, deploy via the usual Vercel flow.

## Notes / decisions

- **Placement:** under `(ecomm)` because these are all ecomm/marketplace channels;
  reuses the ecomm access gate rather than inventing a new PageKey.
- **Seed source:** the same Uniware export used for the standalone recon. To refresh
  from live Uniware, regenerate the seed (the `MYNTRA/scripts/generate_seed.py`
  logic) or wire it to the existing `lib/uniware/client.ts` sync — a natural next step.
- **Rules validated against real data.** The amount rule is `Selling = Total Price`
  (98% pass); an earlier naive `MRP − Discount = Selling` was discarded after it
  produced ~₹9.6L of false positives.
- **Key real findings in this data:** Packet ID is a Myntra-only join key (96% on
  Myntra, ~0% elsewhere); cancelled-with-tax is the dominant exception (₹16.9k);
  HSN missing on 41% of lines; TCS column entirely empty.

## Live sync (added)

`recon_lines` can now be rebuilt from the **already-synced** `raw_uniware.*` tables
(the uniware-sync cron keeps those current) — no second Uniware call.

- `server/db/migrations/0099_recon_refresh_from_uniware.sql` — `ops.refresh_recon_from_uniware()`
  re-derives `recon_lines` from `raw_uniware.sale_order_items` ⋈ `sale_orders` in one SQL pass.
- `web/app/api/recon/refresh/route.ts` — cron-auth-gated GET that calls the function
  (schedule it right after uniware-sync, or hit it manually).

**Honest limitation:** `raw_uniware` carries mrp/selling/total/discount/hsn/status but
**not** GST or packet id (the SOAP feed omits them). So the live refresh computes the
arithmetic exceptions (price mismatch, selling>MRP) + hsn completeness, but not the
tax-based ones. Those need the REST `saleorder/get` feed (`totalCentralGst` …) — a
later enhancement. Until then the CSV seed (0098_seed) is the source for tax exceptions.

## Sequence to go live

1. Run migrations `0098` → `0098_seed` → `0099` (seed gives an immediate snapshot).
2. Once `raw_uniware` has data, hit `/api/recon/refresh` (or schedule it) to switch
   `recon_lines` to live-derived data.
3. `npm install` in `web/`, review, merge, deploy.

## Not done here (intentionally)

- Did not run any migration against the live DB or deploy (your call).
- REST-feed enrichment for GST/packet in the live path is left as a follow-up.
