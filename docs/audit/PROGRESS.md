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

### Wave 3 (Workspace parity, D-05) — LAUNCHED 2026-08-27, one agent, sequential steps

Single agent (not parallel — every step touches `workspace/page.tsx`/`renderSalesComponents.tsx`,
parallel agents would conflict), isolated worktree, committing after each of 4 steps in the
recommended order: 6 (streaming/error boundaries, prerequisite) → 3+4+5 combined (these three
collapse into one task: swap `WeeklySalesTable` for `PeriodSalesFacetedTable`) → 1 (comparison)
→ 2 (product-attribute breakdown, may need a `component_definitions` seed migration — user-run
if so). `tsc --noEmit` + `next build` required clean after each step before proceeding to the
next. When it reports back: review each step's diff and commit message (especially Step 2's
documented decision on the click-to-drilldown-vs-full-swap tradeoff), merge to master one step
at a time like Wave 1/2, verify build after each merge.

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

- **C-09 — FIXED 2026-08-27** (`server/db/migrations/0097_scope_sale_export_stock_scheme.sql`,
  merged to master, RUN against the live DB 2026-08-27 — verified: both `_scoped` views exist).
  Traced every real consumer:
  Replenishment/Sale-vs-Stock-Mix genuinely need whole-network rows by design and keep reading
  the original unscoped views (now hardened with `core.fn_user_role() is not null`, closing the
  no-profile-row gap); stock-details and the workspace stock tiles never needed whole-network
  data and had their own latent scoping bugs on top (stock-details' branch dropdown wasn't
  intersected with the caller's stores; workspace fell through to a fully unfiltered 20k-row
  fetch whenever 0 or >1 stores were selected) — both moved onto new
  `vw_stock_with_scheme_scoped` / `vw_sale_transactions_export_scoped` views.
- **C-06 — FIXED 2026-08-27** (`server/db/migrations/0096_sale_upload_skip_sync_owned_dates.sql`,
  merged to master, RUN against the live DB 2026-08-27 — verified: `fn_process_sale_upload`
  returns jsonb). `ops.fn_process_sale_upload` now silently skips
  Excel rows whose (branch, bill_date) already has a `sale_detail_sync`-sourced row, returns a
  `skipped_sync_owned` count surfaced in the upload UI. Does not retroactively clean the live
  +1 unit/+₹89 drift from the original proof case — that's a separate, not-yet-done cleanup.
- **C-07 — INVESTIGATED AND REJECTED 2026-08-27, do not re-attempt without re-reading this.**
  The audit's premise was wrong: it treated "weekly/monthly ATV includes returns in the
  numerator while daily's doesn't" as a bug to fix by making weekly/monthly match daily
  (sale-bills-only numerator). That exact question was already investigated and explicitly
  DECIDED the other way, twice, in migrations `0050_semantic_layer_grain_corrections.sql` and
  `0051_correct_atv_sale_bills_only_rollup_note.sql`:
    - `0050`'s own header: "Per Objective.md's non-negotiable rule: no business logic changes.
      Where production is internally inconsistent (see ATV below), this migration DOCUMENTS
      the inconsistency rather than resolving it — resolving it would change a displayed
      number, which is a business ruling, not a migration."
    - The catalogue was corrected to point `atv` at the WEEKLY definition
      (`net_sales/sale_bills`, returns netted off) because that is what `computeSalesTotals`/
      `computeLeague` in `aggregate.ts` — and every page — actually renders. The daily view's
      sale-bills-only figure was registered as a SEPARATE, deliberately distinct metric
      (`atv_sale_bills_only`, `sales.vw_ebo_sales_daily.atv`) that "is a legitimate, meaningful
      figure... it simply is not what any page currently displays."
  A same-session attempt at "the C-07 fix" got as far as writing migration
  `0095_atv_weekly_monthly_sale_only.sql` and editing `aggregate.ts`'s four period-series
  builders to sum a new `sale_net_amount`/`saleNet` field instead of `net_sales`/`net` for ATV
  — before this was found and the whole change was reverted (migration file deleted, never
  run against the DB; `aggregate.ts`/`page.tsx` reverted with `git checkout`). Confirmed clean:
  `git status` shows no diff, `tsc --noEmit` clean.
  If this is ever revisited, it needs a genuine PRODUCT decision (does the business want
  ATV to mean "net revenue per sale bill after returns" or "average sale-bill size ignoring
  returns"), not a mechanical "make the grains agree" fix — and should update
  `workspace.metric_definitions` (`atv` vs `atv_sale_bills_only`) and
  `web/scripts/verify-metrics.mjs` (which explicitly asserts the current weekly formula as
  correct) consistently with whatever is decided, not just the view/TS code.
- **C-10 — FIXED 2026-08-27**, merged to master (`1dab0a3`). All 9 hardcoded
  `BO-004`/`BO-002` occurrences replaced with `.filter((s) => s.is_active)`, reading a column
  each site's query now fetches. No DB migration needed — pure TS-side read of data the DB
  already had. `tsc --noEmit`/`next build` clean.
- **C-12 — FIXED 2026-08-27** (`server/db/migrations/0095_delete_test_dummy_rows.sql`, run
  against the live DB — verified: 0 TESTBRANCH rows remain, was 35).
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

### 2026-08-28 — user-reported bug: KPI correct but Period table + Store League empty on a mid-week range

User uploaded a fresh single-day ERP export (28 Aug 2026, a Friday) and screenshotted `/sales`:
KPI "Net Sales" card correctly showed ₹55,198 (verified byte-exact against the ERP file via
direct SQL — see raw_logic.sales_transactions / vw_ebo_sales_daily both matching), but the
"Sales value & quantity by period" table showed "0 rows / No periods match these filters" and
Store League showed "No stores with sales in this window" — both completely empty for the same
date.

**Root cause found and fixed** (commit `3a6014b`): `computeSalesTotals()` in
`web/lib/sales/aggregate.ts` filtered `weekRows` with `w.week_start >= from`. Retail weeks start
Monday; 28 Aug's week starts Monday the 24th, so `'2026-08-24' >= '2026-08-28'` is false — the
CURRENT week got dropped even though it overlaps the requested range. `storesInView` (which
gates the period table, store league, AND agent-wise rows — all built via `page.tsx`'s
`buildRows()`, which loops `storesInView.flatMap(...)`) is derived entirely from `weekRows`, so
it went empty too. This breaks for ANY range not starting on a Monday — a single day, "last N
days", most custom ranges — which is most everyday usage, not just this one date. Fixed by
testing week-END (`week_start + 6 days`) against `from` instead — an overlap test, not a
start-date test.

**This is a DIFFERENT bug from the RETURN sign-convention fix** (`014b1c5`) — that one produced
a wrong NUMBER; this one made rows vanish entirely. Both are now fixed. Not yet deployed to
production — see "Still needed" below.

Also fixed in the same commit: `AgentSalesFacetedTable.tsx`'s "Net" column (network page,
reused by `/sales`) showed ₹60,447 against the KPI's ₹55,198 — off by exactly the returns value
(₹5,249). Root cause: `sales.vw_ebo_agent_daily` is `WHERE bill_type = 'SALE'` BY DESIGN (a
return isn't necessarily processed by the same agent as the original sale, so netting it there
would misattribute it) — a legitimate, deliberate business choice, NOT a bug to silently
"fix" by changing the number (same category of decision as the C-07 precedent below: don't
mechanically force two different, both-correct definitions to agree). What WAS wrong: both
numbers were labeled identically "Net"/"NET" with no indication they measure different things.
Fixed by relabeling to "Net (sale bills)" + an explanatory line above the table — no numbers
changed, only disambiguated. **If the business actually wants Agent-wise net-of-returns, that's
a product decision — flag it, don't silently change it.**

### 2026-08-28 — merged another session's marketplace-reconciliation feature (`feat/marketplace-recon`)

Another session (myntra-91) built a marketplace reconciliation module (new `/reconciliation`
page, `ops.recon_lines` + summary views, live refresh from `raw_uniware`, REST tax/packet
enrichment) on a branch off this repo's own master, and asked this session to merge + push +
run its migrations. Reviewed before merging rather than merging blind (same standard applied to
every agent's work all session) — found and fixed 5 real issues, all in commit `92c7b61` on top
of the merge commit:

1. **`ops.recon_lines`'s RLS policy was `using (true)`** — any authenticated user of any role
   could read the whole network's marketplace pricing/tax exception data directly via PostgREST,
   bypassing the page's own role gate. Scoped to `('ho_admin','super_admin','marketing')` via
   `core.fn_user_role()`, matching `0022`'s established pattern and exactly the role set the
   page/nav already gate on.
2. **`ops.refresh_recon_from_uniware()` granted EXECUTE to `authenticated`** as well as
   `service_role` — the function is `SECURITY DEFINER` and does an unconditional delete+rebuild
   of the whole table; any signed-in user could have triggered it directly via RPC, bypassing the
   route's `cronAuthFailure()` gate. Dropped the `authenticated` grant.
3. **`getReconLines()` used a bare `.limit(5000)`** — this app's own PostgREST Max Rows cap
   (already-known gotcha, see `[[postgrest-max-rows-cap]]` in Claude's memory) silently truncates
   at 1000 regardless of a higher `.limit()`. The 2,399-row seed (and the live table, which will
   be bigger) would have quietly shown ~1000 rows with no error. Switched to `fetchAllRows()`.
4. **`package.json` gained a second, older `ag-grid-community`/`ag-grid-react` entry (`^32.2.0`)**
   alongside the app's existing `^36.1.0` — duplicate JSON keys, and 32.x predates the Theming
   API this session's dark-mode fix (`DataGrid.tsx`) depends on. Removed the duplicate.
5. **`ReconGrid.tsx` built its own bare `<AgGridReact>`** with legacy CSS-file theme imports
   instead of the shared `<DataGrid>` wrapper every other table uses — no dark-mode support, and
   a second theming mechanism active alongside the Theming API (AG Grid's own docs warn against
   mixing the two). Also referenced `border-border-strong` and `var(--bad, ...)` — neither token
   exists in this app (real names: `border-line`, `--crit`) — both were silently falling back to
   hardcoded non-theme-aware colors. Switched to `<DataGrid>` + the app's real tokens.

`tsc --noEmit` + full `next build` (all 37 routes incl. `/reconciliation`, `/api/recon/refresh`,
`/api/recon/enrich-tax`) verified clean after the fixes. Pushed to origin (`92c7b61`).

**Still needed, human action** — none of this has touched the live DB or been deployed yet:
1. Run migrations **in order**, each ends with its own `NOTIFY pgrst`:
   ```bash
   MSYS2_ARG_CONV_EXCL="*" PGPASSWORD='<pw>' "/d/Programs/pgsql/bin/psql.exe" -h aws-0-ap-southeast-1.pooler.supabase.com -p 5432 -U postgres.naukfqwjunorzntnzkok -d postgres -v ON_ERROR_STOP=1 -f "server/db/migrations/0098_marketplace_recon.sql"
   MSYS2_ARG_CONV_EXCL="*" PGPASSWORD='<pw>' "/d/Programs/pgsql/bin/psql.exe" -h aws-0-ap-southeast-1.pooler.supabase.com -p 5432 -U postgres.naukfqwjunorzntnzkok -d postgres -v ON_ERROR_STOP=1 -f "server/db/migrations/0098_marketplace_recon_seed.sql"
   MSYS2_ARG_CONV_EXCL="*" PGPASSWORD='<pw>' "/d/Programs/pgsql/bin/psql.exe" -h aws-0-ap-southeast-1.pooler.supabase.com -p 5432 -U postgres.naukfqwjunorzntnzkok -d postgres -v ON_ERROR_STOP=1 -f "server/db/migrations/0099_recon_refresh_from_uniware.sql"
   ```
2. Deploy (`npx vercel --prod --yes`) — production is still well behind master (last live deploy
   predates almost everything in this file), see the standing "Deploy" item below.
3. Once `raw_uniware` is current, `GET /api/recon/refresh` (with the cron bearer secret) switches
   `recon_lines` from the CSV seed to live-derived data. Tax exceptions won't populate from the
   live path until `/api/recon/enrich-tax` is verified — see the caveat below.
4. **`/api/recon/enrich-tax` is CODE-COMPLETE BUT UNVERIFIED against live Uniware** (per the
   handoff) — the `display_order_code` → internal-code mapping and REST field names
   (`totalCentralGst` etc.) are from Unicommerce docs, not a confirmed run. Run it once manually
   with its default cap (25 orders) and check the result before ever scheduling it as a cron.
5. Full details in `RECON_HANDOFF.md` at the repo root (from the other session) and this section.

### 2026-08-28 — professional zoomable charts (TradingView Lightweight Charts) — DONE, MERGED (`e0a790b`)

User asked to make the Sales page's trend charts interactive like a stock-trading website (zoom on
both X/date and Y/value axes), explicitly "no raw work, very professional." Researched options
(WebSearch) — Tremor's `AreaChart`/`BarChart`/`LineChart` have NO zoom/pan support at all
(confirmed via its `BaseChartProps` type). Picked **TradingView's own `lightweight-charts`**
(npm, v5, open source, ~35KB, canvas, built-in zoom/pan/crosshair) over Apache ECharts — user
confirmed.

Agent `a9b85568de76e140a`, isolated worktree, converting 3 shared chart components from
`@tremor/react` to `lightweight-charts` while preserving every existing prop contract (so
`/sales`, `/network`, Workspace's SalesTrendChart, and a store-drilldown panel all keep working
with zero caller changes): `TrendChart.tsx`, `HourlyBarChart.tsx`, `ComparisonTrendChart.tsx`.

Non-obvious pieces the brief called out explicitly (read the brief in the agent's own transcript
if resuming, or just check its report when it lands):
- The real ISO date was being thrown away in `computeTrendPoints()` (`aggregate.ts`) — only a
  display label ("15 Aug") was kept. lightweight-charts' time-scale needs a real chronological
  value to zoom meaningfully, so the `Point` type needs an additive `date` field, sourced back
  through `aggregate.ts` and wherever `ComparisonTrendChart`'s points are built in `sales/page.tsx`.
- `HourlyBarChart`'s x-axis is hour-of-day (9am-11pm), not a calendar timeline — told to use a
  synthetic UTC timestamp on an arbitrary reference day + a custom tick formatter, so zoom still
  means something (e.g. zoom into just the afternoon peak) without lying about what the data is.
- Dark mode: told to reuse `DataGrid.tsx`'s exact `MutationObserver`-on-`data-theme` pattern
  rather than invent a new mechanism (lightweight-charts isn't theme-reactive on its own).
- Told to WebFetch the current v5 docs rather than rely on remembered API shape — this library's
  API changed meaningfully v4→v5 (`chart.addLineSeries()` → `chart.addSeries(LineSeries, opts)`).
- Told NOT to recreate the whole chart on every data refresh (would reset the user's zoom/pan
  state on every filter change) — only `setData()` the existing series unless the axis shape
  itself changes.

**Result**: agent verified live in a real browser (not just tsc/build) — wheel zoom, drag-to-pan,
independent X/Y drag-zoom via the time/price axes, reset button, dark-mode repaint, and a
data-refresh-preserves-zoom test all confirmed working before it reported back. Merged cleanly
(one new file `chartBase.tsx` shared by all three, `Point.date` widened as OPTIONAL so it degrades
sanely for any future caller that doesn't supply it). `npm install` run in the main checkout after
merge (lightweight-charts@5.2.1 + 1 transitive package added, `tsc --noEmit` + full `next build`
both clean — `/sales`'s First Load JS actually DROPPED, 586kB → 525kB, since lightweight-charts'
canvas approach is lighter than Tremor/Recharts for these three charts). `role="img"` replaced
with `role="group"` + an sr-only per-point text summary — a deliberate, reasoned a11y improvement
(a zoomable/pannable canvas isn't an image, and `role="img"` never exposed the numbers either).
Pushed, worktree/branch deleted.

### 2026-08-28 — "Electro" theme (opt-in, black + neon green, all pages) — LAUNCHED, not yet merged

User showed a fintech-dashboard reference screenshot (near-black background, neon/lime green
line chart, glow accents) and asked for it as a third, OPT-IN theme (Light stays default) across
the whole app, with subtle hover "pop"/glow animations. Scoped after a suggestion pass: agreed
to keep it opt-in (not default) and to NOT apply glow effects inside data-dense areas (AG Grid
rows) — chrome/buttons/nav only, to protect table readability.

Agent `aabddb78924e89f0f`, isolated worktree, single agent (not parallel — this is one cohesive
design decision, splitting risks two agents picking incoherent colors). Extends the existing
light/dark token system in `globals.css` (`:root[data-theme="electro"]`), widens `ThemeToggle.tsx`
from a binary toggle to a 3-way picker (Light/Dark/Electro — a single-click cycle would be bad UX
for a novelty option most users won't want), adds a third `electroGridTheme` to `DataGrid.tsx`
(AG Grid needs hand-pinned hex per theme, can't read CSS vars), and glow-on-hover CSS scoped only
to `[data-theme="electro"]`, respecting `prefers-reduced-motion`. `chartBase.tsx` (the new
lightweight-charts plumbing) reads its palette live off CSS vars already, so it should pick up
Electro for free — agent told to verify this rather than assume it.

Told explicitly: semantic `--good`/`--warn`/`--crit` must stay visually distinct from the new
green ACCENT color (a real correctness concern — a "good" delta badge can't look identical to
decorative chrome), and to actually load the app in a browser and screenshot/describe what it
looks like rather than claim visual verification from code alone.

**When it reports back**: review the diff (especially confirm light/dark are byte-identical to
before via `git diff` on the existing `:root`/`:root[data-theme="dark"]` blocks — this must be
purely additive), merge to `master`, `tsc --noEmit` + `next build`, delete worktree/branch.

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
