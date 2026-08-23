# EBO Sales Intelligence — Handoff Notes

Operational context for picking this project back up in a new session. This file is committed (no secrets in it) — actual credentials live in `web/.env.local` (gitignored) and in the self-hosted server's own config, not here.

## THIS TEST COPY now runs on real Supabase (2026-08-20)

**Read this before touching auth/data-layer code in this repo.** Everything
below this section (self-hosted Keycloak/Postgres/PostgREST/MinIO on
`192.168.1.16`) describes the **real production deployment**, which this
Test copy remains completely isolated from, same as always. But *this Test
copy itself* moved off its own local self-hosted stack onto a real Supabase
project this session — a genuine infrastructure cutover, not a config flag.

- **Project**: `naukfqwjunorzntnzkok` (name "Retail_BI"), ap-southeast-1.
  Credentials in `web/.env.local` (`NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
  `SUPABASE_DB_URL` for direct psql access via the session pooler —
  `db.<ref>.supabase.co`'s direct-connection host is **IPv6-only**, which
  this network can't route; use the pooler host instead,
  `aws-0-ap-southeast-1.pooler.supabase.com:5432`, user
  `postgres.naukfqwjunorzntnzkok`).
- **Auth**: real Supabase Auth (email+password), not Keycloak. Test login:
  `testadmin@retailbi.local` / `TestAdmin123!` (super_admin). `lib/keycloak/*`
  and `lib/postgrest/*` are retired (unused, left in place) — `lib/supabase/*`
  is the live path (`server.ts`/`admin.ts`/`middleware.ts`/`userAdmin.ts`).
  `lib/data/client.ts`/`admin.ts` still export the same `DataClient` type
  every page codes against; only their internals changed.
- **Schema**: all 59 migrations (`0001`–`0059`; `0000` is self-hosted-only —
  Supabase already has `anon`/`authenticated`/`service_role`/`authenticator`
  roles built in, re-creating them errors) applied via psql over the pooler
  connection, plus a new `0060_supabase_current_user_id.sql` (the
  `auth.uid()`-based `core.current_user_id()` that migration `0044` had
  already worked out and then retracted for being applied to the wrong
  project at the time — same SQL, honestly reapplied now that this really is
  the Supabase target). Two real gaps found applying from scratch, both
  fixed inline rather than by editing the migration files: `0027` depends on
  a view `0029` creates (apply `0027` right after `0029`/`0030`, not in
  filename order — `0027`'s own header already documented this from when it
  first shipped to production); `0045`'s `alter role service_role
  bypassrls` needs real Postgres superuser, which Supabase's managed
  `postgres` role doesn't have — skip that one statement, Supabase's
  `service_role` ships with BYPASSRLS by default already (the migration's
  own comment says as much).
- **Data**: the real ERP data this Test copy had loaded locally (93,291
  `item_master` rows, 23,408 `sales_transactions`, 12,513 `scheme_lookup`,
  46,656 `stock_snapshot`, plus a handful of `ops.*` rows) was
  `pg_dump --data-only`'d across and restored — row counts confirmed
  matching exactly. `core.stores`/`retail_calendar` and the
  `workspace.component_definitions`/`metric_definitions`/`dimension_definitions`
  catalogs did NOT need copying — they're seeded by the migrations
  themselves via inline `INSERT`s. Old self-hosted user-linked rows
  (`ops.ebo_monthly_targets.set_by`, `ops.erp_report_uploads.uploaded_by`)
  had their FK values nulled during the copy rather than pointing at a user
  that no longer exists.
- **Storage**: `lib/storage/minio.ts` retired, replaced by
  `lib/storage/supabase.ts` (same 4-function interface — every caller's
  import path changed, nothing else). Two buckets created directly via
  `insert into storage.buckets` (private, not public):
  `erp-reports`, `incentive-targets`.
- **Dashboard config that can't be done via SQL, already done**: Project
  Settings → API → Exposed schemas needed `core, sales, ops, marketing,
  workspace` added explicitly (Supabase's managed PostgREST only exposes
  `public`/`graphql_public` by default) — deliberately did **not** add
  `raw_logic`, matching its own "never queried by the app directly" design.
- **Verified end-to-end this session**: real login (actual `curl`-driven
  form POST through the real Server Action, not a bypass — confirmed a real
  `sb-<ref>-auth-token` session cookie was issued), RLS resolving correctly
  through Supabase's real managed PostgREST (`core.profiles` self-read +
  `sales.vw_ebo_sales_daily` both scoped correctly for the test user), 4
  data-heavy pages (`/network`, `/workspace`, `/stock-details`,
  `/replenishment`) rendering real migrated numbers, the service-role admin
  write path (`core.profiles` insert via `service_role`, the same path
  `inviteUser()` uses), and a full Storage upload/download/delete
  round-trip.
- **Not yet done**: no real users were migrated (none existed in this repo
  — the old Keycloak invite flow was never finished). The Vercel
  `.vercel/project.json` landmine from the old HANDOFF entries is
  unrelated to this move and still applies if this Test copy is ever
  deployed — see that section below, unchanged.

## Stack (production — NOT this Test copy)

- **App**: Next.js 14 App Router, deployed on Vercel. `cd web && vercel deploy --prod` to ship, `vercel logs <url> --json` to check for runtime errors after every deploy.
- **Backend**: Self-hosted on a Windows server (LAN `192.168.1.16`, public IP `103.250.139.98`) — Keycloak (auth) + Postgres + PostgREST (API) + MinIO (file storage). `DATA_BACKEND=selfhosted` in the Vercel env drives `web/lib/data/*` to talk to this stack instead of Supabase (Supabase is legacy/being migrated away from).
- **Credentials**: SSH access + DB password + Keycloak admin creds are in `web/.env.local` and were used ad hoc via SSH+psql this session. Not duplicated here — check that file or ask the user if you need to re-derive them. The `postgres` DB password was reset by the user directly (not recorded here, deliberately) — if you need DB access and don't have it, ask the user rather than trying to read it off the server.
- **Two separate Postgres instances on the same box** — easy to hit the wrong one: `postgresql-x64-16` (port 5432, default install, data dir `C:\PostgreSQL\data`) hosts **only Keycloak's DB**; `postgresql-ebo` (port 5433, data dir `C:\EBO BI\PostgreSQL\data`) hosts the actual app DB, `ebo_bi`. `psql -U postgres -h localhost -p 5433 -d ebo_bi` is the one that matters for app migrations. SSH key: `~/.ssh/ebo_bi_deploy`, host `192.168.1.16`, psql binary at `C:\PostgreSQL\pgsql\bin\psql.exe`. Migrations also live in a mirror copy on the server itself at `C:\EBO BI\migrations\` (SCP new ones there before running).
- **Windows path quirk**: the repo path contains `&` (`Sales & Marketing dashboard`), which breaks npm's `.cmd` shims. Never use `npx`/`npm run` for compiler binaries — invoke directly, e.g.:
  ```
  node "D:/Py/Sales & Marketing dashboard/web/node_modules/typescript/bin/tsc" --noEmit
  ```

## Migrations

- Location: `server/db/migrations/*.sql`, sequentially numbered, additive-only (never edit an already-applied file — add a new one).
- No automated runner exists. Applied manually: SCP the file to the server, then `psql -f <file>` over SSH, in numeric order.
- **After any DDL change, run `NOTIFY pgrst, 'reload schema';`** or PostgREST keeps serving the stale schema silently.
- Current head as of this session: `0039_category_options_include_accessories.sql` (all of 0023–0039 applied and verified live).
- `CREATE OR REPLACE VIEW` cannot reorder/rename output columns — use `DROP VIEW` + `CREATE` instead when column order changes.
- `security_invoker = on` on views is incompatible with this app's security model (the `raw_logic` schema intentionally has zero grants to `authenticated`) — do not re-add it to `sales.vw_ebo_sales_lines` or similar views; see the comment left in migration 0036 explaining why.

## State as of 2026-08-13 (end of last session)

Everything requested through this date is implemented, deployed, and verified live on `https://ebo-sales-intelligence.vercel.app`:

- Targets sync bug fixed (root cause: un-applied migrations, not app logic).
- New sale-report column format studied and ingested; a bill-number-format mismatch that was silently duplicating sales rows was found, confirmed with the user, and 20,975 duplicate rows deleted.
- `bill_type` (Sale Bill/Return Bill) classification fixed for the new bill-number format (migration 0036).
- All store/category/gender/subcategory filters across Targets, Network, Stock Details, Footfall converted to true multi-select with deferred commit (checkboxes batch into one refresh on "Apply", not one refetch per click — this was the fix for "multiple store filter taking too much time").
- Category and Subcategory filters on Targets no longer auto-exclude Accessories/male gender — that exclusion is now entirely user-controlled via the filter UI (migrations 0037, 0039 — there were *two* separate hardcoded exclusions, one per column, both removed).
- Remarks are now tracked separately per Fresh/Discounted bucket (migration 0038).
- Store `BO-004` renamed to "Lucknow - Phoenix Palassio" (direct `UPDATE`, not a migration — this was a "do it quickly" request). It's discontinued: hidden from every store picker/filter *except* Network (kept there for historical reference), and on Network itself its Week-wise Sales / Store League rows are suppressed for any date range where it has zero net_sales/sale_quantity.
- Stock Details' capacity editor grid now respects the active store filter instead of always showing all stores' capacity data.

## State as of 2026-08-13, batch 2 (same day, later session)

Deployed and live (no new `vercel logs` errors after deploy; could not do a full logged-in browser walkthrough — no test credentials available in this session):

- **Targets**: Subcategory filter removed entirely (UI + params); Gender/Category now default to **Female / Apparel** on first visit (no `?gender`/`?category` in the URL) but are fully user-editable/clearable. Implementation note: clearing a filter now writes `?gender=` (present, empty) instead of deleting the param, via `MultiSelectFilter`'s new `clearAsEmptyParam` prop — needed to distinguish "user explicitly cleared" from "never touched, use the default." `ops.fn_monthly_fresh_disc_tracker` still accepts `p_subcategories`; it's just always passed `null` now rather than re-migrating the function.
- **Stock Details totals bug fixed**: `web/lib/stockDetails/aggregate.ts`'s `buildCapacityPlan` now rounds each block's Buffered/Fresh/EOSS once, at build time (`eossCapacity = bufferedCapacity - freshCapacity`, not rounded independently) — previously blocks were rounded only for display while the store-level Total row summed the raw floats, so the Total could be off by 1 from what the four cards on screen actually added up to.
- **Short/Excess flag added**: each capacity block and each store's Total row now shows actual live stock vs. the admin-set planned (buffered) capacity, flagged "Short by N" / "Excess by N" / "On target" (`GapFlag` in `capacity-editor.tsx`).
- **Sinhgad Road showing Undri's numbers — root cause found and fixed** (took a lot of back-and-forth to pin down, worth reading if it resurfaces): it was never a routing/filter bug. `stock-details/page.tsx` fetched **every** store's stock rows (up to 20,000, `.limit(20000)`, no store filter in the SQL) on every load regardless of which store was selected, then filtered in JS — over the real network hop to the self-hosted Postgres box this took 5-8+ seconds. The old `TopProgressBar` safety-timeout hid the loading bar after 6s, so on a slow load the bar would disappear *before* the real fetch landed, leaving the previous (wrong) store's data on screen with no loading cue — which is exactly what looked like "Sinhgad Road shows Undri's data." Confirmed via a real (trusted, not scripted) click test in the Browser pane, checking `window.location.href` and network requests directly: the URL and RSC fetch were always correct, just slow. Fixed two ways: (1) `stock-details/page.tsx`'s stock query now pushes `selectedBranchNames` into a real `.in("branch_name", ...)` SQL filter instead of fetching all stores and filtering client-side — cut load time to ~3s in testing; (2) `TopProgressBar.tsx`'s safety-timeout raised from 6s to 20s (it's only a fallback — the real completion signal, a pathname/searchParams change, still hides the bar the instant a fast navigation finishes). Also cleaned up a real but separate issue found along the way: `StoreFilter.tsx`/`DateRangePicker.tsx` used to call `router.push()` immediately followed by `router.refresh()` — harmless most of the time, but a needless redundant fetch since a new URL is always a client Router Cache miss already; removed the `refresh()` calls, `push()` alone is now used everywhere in these components.
- **Global progress bar**: extended the existing `components/ui/TopProgressBar.tsx` (built by a concurrent session, previously only triggered on `<a>` clicks and form submits) to also fire on `<select>` `change` events and a new `window.dispatchEvent(new Event("progressbar:start"))` call added inside `MultiSelectFilter`'s commit (`StoreFilter.tsx`) — the checkbox-popover filter's Apply/outside-click commit wasn't covered by either of the original triggers. Also added a 500ms show-delay (was instant before) so fast interactions never flash it.
- **Network page**: added a "More KPIs" row (Top store, Weakest store, Scheme penetration %, Stores flagged) and a "Suggested actions" panel, both placed above the Week-wise sales section, computed entirely from data the page already loads (`league`, `schemeRows`, `storeDiagnosis`) — no external AI call. Rule-based bullets cover: WOW decline >5%, discount% >25% of gross, scheme penetration >60%, a >40% net-sales gap between top and bottom store, and the top 3 most-flagged stores' existing diagnosis/recommendation (reused from the footfall×conversion matrix logic already on the page, not new).

## State as of 2026-08-13, batch 3 (same day, third session)

- **Report download bug — real root cause found and fixed**: two layered issues, both real. (1) `getDownloadUrl()`'s presigned MinIO URL was built from `SELFHOSTED_MINIO_ENDPOINT=http://192.168.1.16:9000` — a private LAN address no external browser can ever reach. Confirmed the public IP (`103.250.139.98:9000`) is actually reachable (port forwarded, verified via curl + a live MinIO health response), so the Vercel env var was updated to that. (2) Even after that fix, downloads still silently failed — MinIO has no TLS cert, so it only serves plain HTTP, and modern Chrome/Edge silently block "insecure downloads" reached via redirect from an HTTPS page (no visible error, which is exactly why this was so confusing to diagnose from screenshots). Fixed properly by changing `web/app/api/data-upload/download/[id]/route.ts` from a `NextResponse.redirect()` to actually proxying the file through the Next.js function (`getObjectBuffer` + `new NextResponse(bytes, {headers: {Content-Disposition: attachment...}})`) — same pattern `download-merged/route.ts` already used. Verified end-to-end via direct `fetch()` in the browser: 200, correct filename, correct byte count. Don't reintroduce the redirect-to-MinIO pattern anywhere else in this app; proxy through a Route Handler instead whenever a self-hosted-storage file needs to reach a real user's browser.
- **"Keep latest file only" for Data Upload**: `web/app/api/data-upload/upload/route.ts` now deletes every other `ops.erp_report_uploads` row (and its MinIO object) of the same `report_type` right after a successful upload. Required a new grant (migration `0040_erp_report_uploads_grant_delete.sql` — the RLS policy already allowed DELETE, but the table-level `GRANT` never included it). Existing pre-fix duplicates were cleaned up with a one-time manual `DELETE ... USING` the user ran directly.
- **Stock Details rebuilt around a real "Current Stock vs Planned Display Capacity" comparison table** (`StockVsCapacityTable` in `page.tsx`), replacing what used to be a prose sentence buried in each capacity-editor block. Columns: Segment, Base Capacity, Buffer%, then Fresh and EOSS *each broken out separately* (Planned / Current Stock / Status) — merging Fresh+EOSS into one status previously hid real shortages (e.g. Boys segments are short on EOSS stock at both stores even though Fresh is in heavy excess everywhere — invisible in the old combined view). The "NIBM" naming (a meaningless leftover from a source spreadsheet's filename, not a real term) is gone, replaced with "Gender split — planned capacity" / "Gender split — current stock," both now correctly follow the store filter (previously the planned one was hardcoded to always show all stores regardless of the filter — a real, confirmed bug, not just a wording issue). Also added a Total row above each of the four breakdown tables (Season/Size-group/Color/Size-wise) reflecting the FULL group even when the table itself is truncated (e.g. color's "top 15" — the total is the true total, the rows below are just where).
- Verified via a downloaded stock report + independent Python read of the actual xlsx: the app's "Current stock" numbers match a user-built pivot table exactly, unit for unit, across both stores and both genders. The apparent "huge difference" the user flagged was Planned Capacity vs Current Stock (intentionally very different — capacity is set far below actual stock right now), not a data bug.

## Local dev stack — how to actually start it (2026-08-15)

The all-local stack under `D:\Programs` (see Objective.md's environment note)
has **no start script**. It is four processes, and three of them have a
gotcha that will waste your time if you don't know it. Start them in this
order:

1. **Postgres** — `D:\Programs\pgsql\bin\pg_ctl.exe -D "D:\Programs\pgdata" -l "D:\Programs\pg.log" start`.
   The app DB is `ebo_bi` on **port 5432** here (NOT 5433 — that split is a
   production-server thing, see the two-instances note above; locally there
   is one instance). Auth is trust, so no password is needed locally.
2. **PostgREST** — `D:\Programs\postgrest\postgrest.exe D:\Programs\postgrest\postgrest.conf`, port 3001.
   **`D:\Programs\pgsql\bin` MUST be on PATH** or it dies instantly with
   `error while loading shared libraries: LIBPQ.dll`. Started without that,
   it exits with no log output at all, which looks like it silently did
   nothing. A healthy PostgREST answers `401` on `/` (auth required) — not
   `200`.
3. **Keycloak** — `D:\Programs\keycloak\bin\kc.bat start-dev`, port 8080.
   **The machine's `JAVA_HOME` was broken** (pointed at `D:\Py\jdk17`, which
   does not exist), so `kc.bat` exited immediately with
   `JAVA_HOME ... path doesn't exist` and nothing else. Fixed 2026-08-15 by
   deleting the stale **User**-level env var so the correct **Machine**-level
   one (`C:\Program Files\Eclipse Adoptium\jdk-21.0.11.10-hotspot`) applies —
   user scope overrides machine scope, which is why the good value was being
   shadowed. Keycloak 26.7.1 is verified working on JDK 21. JDK 17 is also
   installed if something ever needs it.
4. **MinIO** — `D:\Programs\minio\minio.exe server D:\Programs\miniodata --address ":9000" --console-address ":9001"`,
   with `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` set from
   `SELFHOSTED_MINIO_ACCESS_KEY`/`SELFHOSTED_MINIO_SECRET_KEY` in
   `web/.env.local`. Buckets `erp-reports` and `incentive-targets` live in
   `D:\Programs\miniodata`. **If MinIO is down, every file upload fails with
   `connect ECONNREFUSED 127.0.0.1:9000`** and nothing else is wrong — this
   is easy to misread as an app bug. It is the service most likely to be
   forgotten, because the verification scripts don't need it.
5. **Dev server** — via the preview tooling using `.claude/launch.json`,
   which now carries a real start command (`node node_modules/next/dist/bin/next dev`,
   cwd `web`). It previously had only a `url`, so it could attach to a
   running server but never start one.

Postgres crashed once this session with
`server process was terminated by exception 0xC0000142` (a Windows
DLL-init failure, not data corruption) and took PostgREST with it; a plain
restart recovered it cleanly with no data loss.

**2026-08-20 — `nohup ... & disown` does not survive between Bash tool
calls in this harness.** Starting PostgREST/Keycloak/MinIO that way looked
fine (the process logged "started"/"listening") but was gone by the next
tool call — each Bash invocation appears to run in its own subshell whose
teardown kills children regardless of `disown`. Fixed by starting each with
PowerShell's `Start-Process -WindowStyle Hidden -RedirectStandardOutput ...
-RedirectStandardError ...` instead, which detaches properly. PostgREST
still needs `-WorkingDirectory "D:\Programs\postgrest"` specifically
(`postgrest.conf`'s `jwt-secret = "@jwk.json"` is a relative path, resolved
against cwd, not the exe's location) — running it from any other cwd fails
fast with `jwk.json: does not exist`, easy to misread as the already-fixed
LIBPQ.dll issue if you don't read the log.

**2026-08-20 — this session's Browser-pane tab would not composite
frames at all.** `screenshot` always failed with "the Browser pane is not
displayed"; clicks, Enter-key submits, and even a direct
`element.requestSubmit()` via `javascript_tool` on the login form produced
zero effect — no request ever reached the Next.js server (confirmed via an
unchanged dev-server access log across several attempts). Verified this was
a Browser-pane rendering limitation, not a real login bug, two ways: (1)
`curl`-ing the Keycloak token endpoint directly with the test credentials
returned a real JWT, and (2) `curl`-ing an app page with that JWT set as
the `sh_access_token` cookie returned real server-rendered HTML. When this
happens again: fall back to `curl` with a manually-obtained Keycloak token
as a cookie to verify server-side rendering/compute, rather than assuming
the app is broken or burning time retrying browser interaction.

## Verification harnesses (there is still no test framework)

Four now exist. All are plain Node/psql, matching the project's existing
convention rather than introducing Jest. Run from `web/` **invoking `node`
directly** — the `&` in the repo path breaks npm `.cmd` shims:

- `node --env-file=.env.local scripts/verify-metrics.mjs` — metric
  cross-derivation: reads each metric from the source the CATALOGUE names and
  independently recomputes it from component columns using the app's own
  formula. Marks `is_verified` on success (add `--write`; without it, reports
  only). Searches live data for a scope containing RETURN bills, and REFUSES
  to verify `atv` without them — with zero returns the daily and weekly ATV
  formulas coincide, which is how migration 0048 shipped a wrong
  `source_column` past a green run. Replaced `parity-check.mjs`, deleted
  2026-08-23: that script asserted literals from a fixture that no longer
  exists, and rebaselining them to real data would have made it a tautology.
- `node --env-file=.env.local scripts/verify-query-planner.mjs` — Phase 4
  planner: grouping, grain splitting, extraColumns.
- `node --env-file=.env.local scripts/verify-filter-engine.mjs` — Phase 6
  governed filters, including that an inapplicable filter is REFUSED rather
  than silently dropped.
- `psql ... -f server/db/tests/rls_workspace_sharing.sql` — Phase 7 sharing
  RLS. Simulates multiple users via the `app.user_id` GUC (no accounts are
  created). **This one caught a real privilege-escalation bug** — run it
  after any change to workspace RLS.

`server/db/seeds/dev_fixture.sql` generates a synthetic dataset (sale,
return and other bills, scheme groups, parseable bill times, footfall) for
when the local DB is otherwise nearly empty. It is idempotent, deliberately
skips the BO-001/2026-08-10 parity fixture, and is tagged for one-command
removal (`SB-F%`/`RB-F%`/`EX-F%` bill numbers, `remarks='dev_fixture'`
footfall). **Remove it before loading real data** or the two datasets render
combined.

## Two silent-failure formats worth knowing

Both were found on 2026-08-15 and both fail by producing NOTHING rather than
an error, which makes them hard to notice:

- **`bill_time` only parses `HH:MM:SS AM/PM`** (`sales.vw_ebo_sales_lines`).
  A 24-hour value like `14:30:00` becomes NULL and the row disappears from
  `sales.vw_ebo_sales_hourly` entirely — the hourly chart just renders empty.
  If a real export uses 24-hour times, hourly sales will silently show
  nothing.
- **`bill_type` keys on `SB-` / `RB-` including the dash** (0036). A bill
  number like `SBF-123` matches `%SB%` but NOT `%SB-%`, so it classifies as
  `OTHER`: zero sale bills, zero returns, no error. Any drift in bill-number
  format misclassifies silently.

## State as of 2026-08-15, item master + Configurations page

- **Migrations 0055-0059** applied to the local dev DB. 0055 fixes the
  Fresh/Disc tracker view/function divergence (dead-code view, no live
  callers). 0056 repoints `sales.vw_ebo_sales_lines`/`vw_item_subcategory_lookup`/
  `vw_stock_with_scheme` to read product-detail fields from
  `raw_logic.item_master` by barcode, falling back to each view's prior
  source when a barcode isn't yet in `item_master`. 0057 adds
  `core.app_settings` (first generic settings table). 0058 makes the
  Fresh/EOSS classification source (`discount_ratio` vs `scheme_lookup`) an
  admin setting instead of hardcoded SQL. 0059 fixes a grant bug in 0057
  (service_role needs an explicit GRANT on the table even though it has
  `bypassrls` — same lesson as 0045, re-learned the hard way, caught by an
  actual browser test of the Save button failing with "permission denied for
  table app_settings").
- **New `/configurations` route** (`super_admin` only), first real settings
  page in the app — `web/app/(configurations)/`. Verified in-browser: nav
  entry renders, page loads, Save round-trips to `core.app_settings` and
  back, `ops.fn_monthly_fresh_disc_tracker`'s output changed correctly under
  both settings values. Left at `discount_ratio` (unchanged default) after
  testing.
- **Known issue surfaced, not fixed**: the synthetic parity fixture
  (`SB-1001`/`SB-1002` on `BO-001`, 2026-08-10) now collides with real
  uploaded data on the same store/date, so `parity-check.mjs` and
  `verify-query-planner.mjs` both fail on stale hardcoded totals. Confirmed
  unrelated to this session's changes (every failing assertion is a plain
  amount column, not touched). Needs the fixture rows removed or moved to a
  non-colliding date before those two scripts are trustworthy again.
- Dev server for this session ran on an auto-assigned port (3000 was held
  by a concurrent session) — `.claude/launch.json`'s `web-dev` config now
  has `"autoPort": true` so this doesn't block future sessions either.

## State as of 2026-08-15, batch 4 — Workspace expansion, real UI stack, real fonts

- **New npm dependencies installed** (`web/package.json`): `ag-grid-community`,
  `ag-grid-react` (v36, the new Theming API — `themeQuartz.withParams()`,
  not the old CSS-theme-file approach; requires
  `ModuleRegistry.registerModules([AllCommunityModule])` before any grid
  renders or it errors); `@tremor/react` (v3.18.7 — note this is the
  legacy line, Tremor's own active investment moved to "Tremor Raw" which
  needs Tailwind v4 and does NOT fit this project, still on v3.4.13);
  `@headlessui/tailwindcss`, `tailwindcss-animate`,
  `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`,
  `@radix-ui/react-slot`, `@radix-ui/react-dialog`,
  `@radix-ui/react-dropdown-menu`. One install run failed to write
  `package.json` (`npm error UNKNOWN: unknown error, open ... package.json`
  — a Windows file-lock, likely the running dev server holding it open)
  even though the packages themselves landed in `node_modules` correctly;
  had to hand-edit `package.json`'s `dependencies` to match. If a future
  `npm install` silently doesn't update `package.json`, check for this
  before assuming the install failed outright.
- **`.next` build-cache corruption from rapid dev-server restarts**: after
  several stop/start cycles of the preview server, webpack threw
  `Cannot find module './vendor-chunks/tailwind-merge...'` — looked like a
  missing dependency but wasn't (already installed, already typechecking
  clean). Fixed by `rm -rf web/.next` and restarting. If a "Cannot find
  module" error appears for a package you know is installed, try this
  before anything else.
- **`web/.vercel/project.json` already exists in this Test copy** —
  `{"projectId":"prj_wMMGEP0889WmOJUqQ8B1RDaThENL","orgId":"team_...","projectName":"ebo-sales-intelligence"}`.
  This links the directory to the **SAME real production Vercel project**
  the live app (`https://ebo-sales-intelligence.vercel.app`) deploys from.
  **A bare `vercel deploy --prod` run from this Test copy would ship
  straight to real production** — this copy's env vars point entirely at
  an all-local dev stack (Keycloak/Postgres/PostgREST/MinIO on
  `localhost`, unreachable from Vercel's servers) and its migrations
  (0046–0059) have never been applied to the real production database, so
  such a deploy would be both dangerous (overwrites the real live app)
  and broken (every page would fail to fetch data even if it somehow
  didn't touch prod). A deploy was requested this session and then
  explicitly cancelled by the user before anything ran — nothing was
  pushed. Before ever deploying from this directory: confirm which
  project you actually want to target (unlink and re-link to a fresh
  test project via `vercel link` if a separate preview is wanted), and
  never run this against real production without the user explicitly
  directing it.
- **Migrations 0055–0059 applied to the LOCAL dev DB only** (item_master
  wiring, `core.app_settings`, dynamic Fresh/EOSS classification —
  see Objective.md's dated entries for what each does). Current local
  migration head is **0059**, not the `0039` noted in the "Migrations"
  section above — that note is from the 2026-08-13 session and is now
  historical; treat `server/db/migrations/` itself as the source of truth
  for the real current head, not any single prose note in this file.
- Everything else from this batch (Workspace switcher/multi-workspace
  support, 2 new non-Sales workspace component families, Phase 8 drilldown,
  Phase 9 lazy-mount, real Tremor charts, AG Grid + shadcn-shaped
  primitives, real fonts via `next/font`, the Sale vs Stock Mix SOH split)
  is documented in `Objective.md`'s dated sections — not duplicated here,
  per this file's own stated boundary (operational "how", not product
  "what/why").

## Known open items / things to watch

- **Migrations 0050-0053 are applied to the LOCAL dev DB only** (2026-08-15)
  and have never been near production. 0050/0051 correct the semantic-layer
  catalogue (no view or displayed number changes); 0052/0053 add workspace
  sharing. **0052 must never be applied without 0053** — 0052 as first
  written contained a privilege-escalation bug (a client-supplied `owner_id`
  forged the whole authorization decision) that 0053 fixes with a trigger.
  Treat them as one unit.
- **Logic ERP live connector**: was blocked on port 1433 (SQL Server) being unreachable from the self-hosted box at the time this was last touched — not resolved in this session, worth checking if it's come up again.
- A separate/parallel session or account has been making concurrent changes to this repo during this period (i18n additions, `data-upload` page rework, `TopNav` prop changes) — these were confirmed intentional and left alone, but double-check `git log` for recent unfamiliar commits before assuming you have the full picture of current state.
- No automated test suite exists for this app — verification has been "run `tsc --noEmit`, deploy, then manually check the live URL with the browser tools + `vercel logs`." Keep doing that for any change that touches a page users hit directly.
