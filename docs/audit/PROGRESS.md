# Full application audit — plan & progress

Last updated: 2026-08-27, by Claude (session continuing from Sales-page Phase 3/4 work).
Read this file first if resuming in a new session — it has everything needed to continue
without re-deriving context.

## Context / how we got here

User asked for a full end-to-end audit ("zero untested areas") after finding that Sales
value AND quantity didn't match their ERP report. Root cause of THAT specific complaint was
found and fixed same-day (commit `014b1c5`, RETURN sign convention — see
[project_return_sign_convention_bug.md](../../../../../.claude/memory/project_return_sign_convention_bug.md)
in Claude's persistent memory). While investigating, the user separately ran a **much bigger,
4-agent parallel audit** (filters / API+security / database / frontend) using another account
and saved the results as markdown. This session's job: find those reports, read them, fix
everything fixable, track anything that needs a human decision.

## Where everything lives

- **The four audit reports** (read these for full evidence — file:line + code proof for every
  finding): [`docs/audit/A-filters.md`](A-filters.md), [`docs/audit/B-api-security.md`](B-api-security.md),
  [`docs/audit/C-database.md`](C-database.md), [`docs/audit/D-frontend.md`](D-frontend.md).
  Committed at `1d1871f`.
- **This file** — plan + running status. Update it as work completes.
- **DB access**: `web/.env.local`'s `SUPABASE_DB_URL`. `npx` and URI-form `psql` are BROKEN on
  this machine (repo path contains `&`). Working form from git-bash:
  ```
  MSYS2_ARG_CONV_EXCL="*" PGPASSWORD='<decoded password>' /d/Programs/pgsql/bin/psql.exe -h aws-0-ap-southeast-1.pooler.supabase.com -p 5432 -U postgres.naukfqwjunorzntnzkok -d postgres -c "<SQL>"
  ```
  The password in `.env.local` is percent-encoded — decode before use (`%2F`→`/`, `%21`→`!`, `%2B`→`+`).
- **Vercel deploy**: `npx vercel --prod --yes` from `web/` (needs `npx vercel login` once per
  machine/session — the globally-installed `vercel` CLI on this machine has no stored
  credentials separate from the npx-fetched one). Production alias: `https://pep-retail-bi.vercel.app`.
- **DB-writing actions are blocked by the Claude Code auto-mode classifier** — every migration
  apply and every `vercel --prod` deploy must be run BY THE USER, not by Claude directly. Give
  them the exact command; don't try to route around the block.

## Status as of last update

### Done and merged to `master`

1. `014b1c5` — RETURN sign convention fix (code: sync route + compute.ts/mix.ts). **DB backfill
   migration `0093_fix_synced_return_sign.sql` written but** ⚠️ **NOT YET CONFIRMED RUN by the
   user** — ask them to confirm, or re-check with:
   ```sql
   select count(*) from raw_logic.sales_transactions
   where source='sale_detail_sync' and bill_no like '%RB-%' and net_amount > 0;
   -- must be 0
   ```
2. `507ea4f` — Ecomm channel table RSC crash fix (function prop across server/client boundary).
3. Sales page Phase 3 (Season+Year attribute breakdown) + Phase 4 (period comparison) + store
   dividers/Network total — all merged, all deployed.
4. `0199a3d` — Migration `0094_audit_fixes_batch1.sql` (view/function-only, additive): C-02
   (bill_time regex), C-04 (Ecomm discount derivation), C-08 (Ecomm cancelled-order
   consistency), C-11 (fn_user_business_units service_role branch), C-13 (discount_amount
   COALESCE). Plus `vercel.json`: scheduled `/api/cron/sale-detail-sync` (was B-01 — never
   scheduled, current-FY data was frozen since the one manual sync on 26 Aug).
   ⚠️ **Migration 0094 also NOT YET CONFIRMED RUN** — same DB-access blocker, user must run it:
   ```bash
   MSYS2_ARG_CONV_EXCL="*" PGPASSWORD='<pw>' "/d/Programs/pgsql/bin/psql.exe" -h aws-0-ap-southeast-1.pooler.supabase.com -p 5432 -U postgres.naukfqwjunorzntnzkok -d postgres -v ON_ERROR_STOP=1 -f "server/db/migrations/0094_audit_fixes_batch1.sql"
   ```
5. `1d1871f` — audit reports committed to `docs/audit/`.

### Done and merged — all 5 parallel fix batches (as of `5277ce9`)

All 5 worktree agents completed, were reviewed, committed, merged one at a time into `master`
with `tsc --noEmit` + `next build` verified clean after each merge, and their worktrees/branches
deleted. Full build (`next build`) also verified clean on the final merged state — all 36 routes
compile.

| Batch | Scope | Fixed |
|---|---|---|
| Security | B-03 through B-14 | All 12 — see commit for `web/lib/cron/auth.ts` (fail-closed CRON_SECRET), `web/app/api/_shared/{requireRole,finYear,targetsUploadLimits}.ts` (new shared helpers), role gates on upload-url/sale-detail/bulk-preview/template/targets-upload, `fetchAllRows` on download-merged, Uniware fetch timeouts+retry, SMTP timeouts, bulk-commit max(5000). **Skipped**: B-04's bucket-level `file_size_limit` — no `storage.buckets` migration exists to amend (0018/0022 both explicitly decline to manage buckets at the DB layer); needs a new migration or a Supabase dashboard change. |
| Sales correctness | A-01,02,03,04,05/D-01,08,09,10,11,12,D-21 | All 12 — IST date-preset bug (`DateRangePicker.tsx`), product-attribute facet retargeting, numeric-condition blank-value guard, `/sales` pagination (`fetchAllRows` on 7 query sites), Ecomm cancelled-orders now populated, channel picker reachable when both EBO+ECOM active, date-picker resync, text `blank`/`not_blank` operators, facet select-all union, `channelHref` date-baking, Returns column sign display + stale header comment. |
| Movement filters | A-06,07,16,17,18 | A-17 investigated first and found the audit's own A-07 premise partially wrong (5 of 7 `mix_*` params are dead — never read server-side, Mix-tab filtering is local React state not URL state) — fixed based on ground truth (wired only the 2 real params, `mix_store`/`mix_period`, deleted the dead `buildHref` and the 5 dead param declarations) rather than mechanically following the audit's suggested fix. A-06: attribute-combo views now actually apply active facet filters (via a filtered-item-keys join) instead of silently discarding them. A-18: added an additive, backward-compatible `defaultGroupBy` prop to `FacetFilterBar` (not yet used by any Movement caller — no default grouping existed to preserve, noted for future use). A-15 explicitly left for a human decision (low impact, judgment call). |
| Frontend polish | D-06,08,09,10,13,15,16,17,20 | All 9 — new `app/error.tsx`+`global-error.tsx`, campaigns/footfall/targets empty-states, `FacetFilterBar` saved-views fetch catch+unmount guard, `CategoryTracker` number formatting, dead-code removal (`RowsPerPageSelect.tsx`, `react-hook-form` dependency — **`npm install` still needs one human run** to update `package-lock.json`), mobile nav rebuilt as a single-row `overflow-x-auto` bar (was overlapping page content), `requirePageAccess` added to 2 redirect stubs. |
| Dark grids + progress bar | D-03, progress-bar gaps 1&2 | `DataGrid.tsx` now switches a light/dark `themeQuartz` composition via a `MutationObserver` on `data-theme` (covers all 9 ag-grid tables) — **visual verification in an actual browser still outstanding**, only reasoned-through, not screenshotted. New `app/loading.tsx` + `(ecomm)/loading.tsx`, new `useProgressTransition` hook wired into the 6 `useTransition` call sites the audit named. |

`FacetFilterBar.tsx` was touched by 4 of the 5 batches, each for a distinct, non-overlapping
reason — all merged cleanly via git's automatic merge (`ort` strategy), verified by grep that
every batch's markers survived (`useProgressTransition`, `blank`/`not_blank`, the `c.value===""`
guard, `Select all shown`, `defaultGroupBy`).

**Still needed, human action**:
1. ✅ DONE 2026-08-27 — `npm install` run in `web/`, `react-hook-form` removed, lockfile clean.
   (`npm audit` now flags 2 high-severity transitive vulnerabilities — not investigated yet,
   do NOT run `npm audit fix --force` without reviewing what it changes first.)
2. Visually verify dark-mode ag-grid theming on a real browser (`/sales`, toggle dark mode). —
   still outstanding.
3. ✅ DONE 2026-08-27 — migrations `0093` and `0094` both run against the live DB by the user,
   verified: `return_rows_still_positive` = 0 (was 227), `0094` applied clean (4 views +
   1 function + comments, no errors). Note for future verification: `sales.vw_ebo_sales_lines`
   and its dependents filter on `core.fn_user_store_ids()`, which returns empty for a raw
   superuser psql connection (no JWT/role claim) — a `select count(*)` against these views from
   psql will show 0 even when the fix is correct. Verify app-level fixes through the app/API,
   not a raw psql count.
4. Deploy (`npx vercel --prod --yes`) and smoke-test. — still outstanding.

### Wave 2 (table subtotals, D-04/D-07/A-13) — all 3 agents done, ALL MERGED to `master`

Reviewed and merged 2026-08-27 (commits `9936fd4`, `4b25a53`, on top of the earlier
`1853183`). `tsc --noEmit` and full `next build` (all 36 routes) both clean after
the merges. Worktrees + branches deleted.

User confirmed: proceed with subtotals + Workspace parity, sequenced (subtotals first, since
Workspace parity's own port plan reuses several of these same shared components — e.g. item 4
of the parity diff says "replace WeeklySalesTable wholesale with PeriodSalesFacetedTable" — so
fixing subtotals on the Sales-page-shared components first means Workspace inherits them for
free instead of needing the work done twice).

`DataGrid.tsx` needed NO base change — `pinnedBottomRowData` is a plain `AgGridReactProps` field
already spread through; each agent adds it directly per-table.

| Agent | agentId | Scope | Files |
|---|---|---|---|
| Sales + Network shared tables | `a3d071f50063e2c01` | `PeriodSalesFacetedTable.tsx` (+ D-07 real pinned grand-total row, + A-13 pageKey-per-grain fix), `ProductAttributeSalesTable.tsx`, `EcommChannelFacetedTable.tsx`, `AgentSalesFacetedTable.tsx`, `StoreDiagnosisFacetedTable.tsx`, `StoreLeagueDrilldown.tsx` (also used by Workspace — fixing here benefits the later parity port), 2 plain tables inline in `sales/page.tsx` |
| Movement tables | `aacad0de0f99f171c` | `AttributeMixGrid.tsx`, `AttributeReplenishmentGrid.tsx`, `ReplenishmentGrid.tsx`, `SaleStockMixGrid.tsx`, Top-movers table in `movement/page.tsx` |
| Stock-details / Targets / Footfall tables | `a737998b0f924434c` | `StockVsCapacityGrid.tsx`, stock-details gender/segment table, `CategoryTracker.tsx` (×2 instances), `bulk-upload-form.tsx` preview table, footfall daily log table |

All three given the audit's own per-column aggregate-type spec (D-frontend.md's "Table
inventory") as their baseline, with the explicit rule: ratio columns (ATV/UPT/Discount%/
Conversion/Cancel%/Cover/Mix%) must be RECOMPUTED from summed numerator/denominator, never
averaged row-by-row — each agent told to verify its formula against how the same ratio is
already computed elsewhere in the same file, not invent one.

**When these report back**: same procedure as Wave 1 — review diff, commit if uncommitted,
merge to `master` one at a time, `tsc --noEmit` + `next build` after each, delete worktree/branch.

### Wave 3 (Workspace parity, D-05) — NOT STARTED YET

Start only after Wave 2 is fully merged and verified — Workspace parity's port plan (see
`D-frontend.md`'s "Sales → Workspace parity diff" section) directly reuses several Wave-2-fixed
components (`PeriodSalesFacetedTable`, `StoreLeagueDrilldown`, `AgentSalesFacetedTable`,
`StoreDiagnosisFacetedTable`), so doing it before Wave 2 lands would mean either porting
not-yet-fixed components (redoing work) or racing Wave 2's edits to the same files.

Recommended port order per the audit: **6 → 3 → 4 → 1 → 5 → 2** (streaming/error-boundary
work first — Workspace currently has ONE blocking `Promise.all` for all six data families and
zero Suspense boundaries, so adding the other five items' extra queries before fixing that
makes it strictly worse). Full file-by-file breakdown already in `D-frontend.md`.

### Explicitly deferred to a later wave (do NOT start until the above 5 are merged and verified)

Reason: these touch nearly every table file in the app, which would conflict with any of the
5 in-flight agents.

- **D-04 / D-07 / A-13** — table subtotal/total-row feature (user's explicit ask: "add subtotal
  in-fact in every table where there is numbers... sum, avg as per suitable to column data").
  Full per-table aggregate-type inventory already worked out in `D-frontend.md`'s "Table
  inventory" section — ratio columns (ATV, discount%, conversion, etc.) must be RECOMPUTED from
  summed numerator/denominator, never averaged. `PeriodSalesFacetedTable.tsx`'s existing
  tint-only "Network total" separator (D-07, the user's specific complaint: "not as our working
  standards") gets replaced by a real footer row as part of this same pass. A-13 (saved views
  keyed per calendar grain) is a one-line fix, bundle it into whichever agent touches
  `PeriodSalesFacetedTable.tsx` for this pass.
- **D-05** — Workspace parity (user's explicit ask: "all features of sales are not available on
  Workspace page copy all there"). Full file-by-file port plan already in `D-frontend.md`'s
  "Sales → Workspace parity diff" section, with a recommended port order:
  **6 → 3 → 4 → 1 → 5 → 2** (streaming/error-boundary work first, since it's a prerequisite —
  Workspace currently has ONE blocking `Promise.all` for six data families and zero Suspense
  boundaries, so adding more expensive queries to it before fixing that makes it worse).

### Explicitly NOT going to be auto-fixed (need a human/product decision)

- **C-09** (P2, security) — `vw_sale_transactions_export` / `vw_stock_with_scheme` have no
  store/role scoping of their own, reachable directly over PostgREST bypassing the route-level
  role check. NOT fixed in 0094 because Replenishment/Mix read both views for roles broader
  than ho_admin/super_admin — a blind role-gate at the view level would lock out legitimate
  users. Needs: a decision on which roles should see whole-network line-level data via which
  path, then either a role-gate on the view or a narrower-purpose view for the broader-access
  callers.
- **C-06** (P2) — Excel upload and nightly sync can double-count the same bill line (different
  `line_seq` derivation per writer). Small blast radius today (+1 unit, +Rs 89) but unbounded if
  someone re-uploads Excel for a sync-owned date range. Recommended fix (not yet built): refuse/
  auto-delete Excel rows for dates the sync owns.
- **C-07** (P2) — `atv` defined differently at daily grain (SALE-only numerator) vs weekly/
  monthly (returns-inclusive numerator). Needs a `sale_net_amount` column threaded through
  `vw_ebo_sales_daily` so weekly/monthly can recompute correctly — a real (small) migration.
- **C-10** (P2, latent) — store exclusion (`BO-004`/`BO-002`) implemented twice: SQL views via
  `is_active`, TypeScript via a hardcoded id list in 9 files (also D-18, partially overlapping —
  D-18 was assigned to the frontend-polish agent as a code-quality note but NOT as a full fix of
  the dual-mechanism risk; C-10's actual fix (single source of truth) is bigger and deferred).
- **C-12** (P3) — 35 `TESTBILL_*`/`TESTBRANCH` dummy rows in production `raw_logic.sales_transactions`
  (harmless — never join `core.stores` so never reach any dashboard number, but pollute the raw
  export). Simple `DELETE`, needs the user to run it (DB write).
- **C-14, C-15, C-16, C-17** (P3, schema hygiene) — `bill_date` as text not date, UTC/IST edge
  cases (00:00-05:30 IST window only), master-upload can't clear a field, missing FK indexes.
  Low priority, not started.
- **D-11** (P2) — two placeholder pages (`my-store`, `campaigns`) ship internal implementation
  notes to end users in production. Needs either finishing the real screens or writing neutral
  "Coming soon" copy — a content/product decision, not a mechanical fix.
- **D-12** (P2) — `INR()`/`fmt`/`PCT` formatters duplicated across 16+ files, one divergent
  (lakh notation) variant. Needs a decision on whether lakh notation becomes house style, then
  a `lib/format.ts` consolidation touching many files — deferred, do as its own pass once the
  table-subtotal wave (which also touches many of the same files) is done, to minimize
  re-touching the same files twice.
- **D-14** (P3) — trivial, `useMemo` that never caches in `EcommChannelFacetedTable.tsx` — small,
  could be folded into a future pass on that file.
- **D-19** — `npm run typecheck`/`npm run lint` don't work from this checkout path (contains
  `&`). Workaround already in use throughout this session: invoke binaries directly via
  `node .\node_modules\<pkg>\...`. Real fix (rename directory, or `.npmrc` `script-shell`) is a
  user decision, not attempted.
- **D-02** (P1) — ESLint has no config at all; `next lint` drops into the interactive setup
  wizard. Fix is `npx next lint --strict` once (interactive, needs a human at a real terminal)
  to generate `.eslintrc.json`, then add `eslint`+`eslint-config-next` to devDependencies and
  review the 7 existing blind `eslint-disable` comments. Not attempted — needs an interactive
  session.

## Next steps (in order)

1. Wait for the 5 in-flight agents to report back (background notifications will arrive).
2. Review each diff, merge to `master` one at a time, `tsc --noEmit` + `next build` after each
   merge (not just at the end — catch a bad merge early).
3. Confirm with the user that migrations `0093` and `0094` have actually been run against the
   live DB (ask, or re-check via the SQL snippets above).
4. Deploy (`npx vercel --prod --yes`, user-run) and spot-check the live site.
5. Start the deferred waves in order: table-subtotal feature (D-04/D-07/A-13) → Workspace parity
   (D-05, port order 6→3→4→1→5→2) → D-12 formatter consolidation.
6. Surface the "needs a human decision" list above to the user explicitly; don't silently drop
   any of them.
7. Once all of the above lands, do a final regression pass: reload every page in the app as a
   real user would, confirm no P0/P1 remains open, and write the closing "Final Audit Report"
   section the original audit brief asked for (coverage %, bugs found/fixed table, remaining
   known issues) — the original brief explicitly said not to claim "100% bug-free," report
   actual coverage instead.
