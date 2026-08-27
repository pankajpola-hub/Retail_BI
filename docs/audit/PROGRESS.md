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

### In progress — 5 parallel worktree agents launched, NOT YET MERGED

Each in its own isolated worktree/branch, fixing a distinct, non-overlapping set of files.
When each reports back: review its diff, merge to `master`, run `tsc --noEmit` + `next build`
on the merged result, then move to the next.

| Agent | agentId (for SendMessage if resuming) | Scope | Files |
|---|---|---|---|
| Security | `a6c1659f213b97fed` | B-03 through B-14 (API routes, RBAC, timeouts, error leaks) | `web/app/api/**`, `web/lib/uniware/client.ts`, `web/lib/alerts/mailer.ts`, new `web/lib/cron/auth.ts` |
| Sales correctness | `ad39b18cfa563b48b` | A-01, A-02, A-03, A-04, A-05/D-01, A-08, A-09, A-10, A-11, A-12, D-21 | `web/app/(ho)/sales/**`, `FacetFilterBar.tsx`, `DateRangePicker.tsx`, `ComparisonDateRangePicker.tsx`, `lib/sales/attributeBreakdown.ts` |
| Movement filters | `a2db505ac80b29c6e` | A-06, A-07, A-15, A-16, A-17, A-18 | `web/app/(replenishment)/movement/**`, `FacetFilterBar.tsx` (additive `defaultGroupBy` prop only) |
| Frontend polish | `a109b117bba398a61` | D-06, D-08, D-09, D-10, D-13, D-15, D-16, D-17, D-20 | `web/app/error.tsx` (new), `web/app/global-error.tsx` (new), campaigns/footfall/targets pages, `FacetFilterBar.tsx` (D-10 useEffect only), `AppShell.tsx`, `package.json` (react-hook-form removal — note: `npm install` needed once after merge) |
| Dark grids + progress bar | `a912ce8f7fc8d16ed` | D-03, progress-bar gaps 1&2 | `DataGrid.tsx`, new `web/app/loading.tsx`, new `web/components/ui/useProgressTransition.ts`, 6 `useTransition`→`useProgressTransition` call sites incl. `FacetFilterBar.tsx` (that swap only) |

**Note**: `FacetFilterBar.tsx` is touched by THREE of the five agents, each for a distinct,
non-overlapping reason (Sales-correctness: A-03/A-10/A-11 numeric-guard + text-blank-op +
select-all-union; Movement: A-18 additive `defaultGroupBy` prop; Frontend-polish: D-10 the one
`useEffect` catch/cancel fix; Dark-grids: the `useTransition` import swap at ~line 193). This
was deliberate — the four changes are in different functions/sections of the file and were each
given surgical, minimal-diff instructions to avoid conflicts. **When merging, merge these in
some order and re-run `tsc`+`build` after each — if a real conflict surfaces despite the
instructions, resolve by hand, don't just take one side.**

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
