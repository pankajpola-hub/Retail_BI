# Audit D — Frontend, States, Tables & Code Quality

- **Date:** 2026-08-27
- **Repo:** `D:\Py\Sales & Marketing dashboard_Test`
- **Commit audited:** `014b1c533ae877002bf92a8204efa7590d8ad299` (branch `master`)
- **Scope:** `web/` — Next.js 14 App Router, React 18, Tailwind, ag-grid-community 36, react-grid-layout, Tremor
- **Pages reviewed:** all 19 in scope (see Page × State matrix — no gaps)
- **Method:** static read of every page, layout, client component and table component; `tsc --noEmit` run; `next lint` attempted; exhaustive greps for the listed code-quality patterns. No source file was modified.

> **Note on running the npm scripts:** the repo path contains an `&`
> (`Sales & Marketing dashboard_Test`). npm's script shell splits on it, so
> **`npm run typecheck` and `npm run lint` both fail before the tool starts**:
> ```
> 'Marketing' is not recognized as an internal or external command
> Error: Cannot find module 'D:\Py\typescript\bin\tsc'
> ```
> Both were therefore invoked directly (`node ./node_modules/typescript/bin/tsc --noEmit`,
> `node ./node_modules/next/dist/bin/next lint`). See findings **D-19** and **D-02**.

---

## Summary table

| ID | Severity | Page/Area | One-line |
|---|---|---|---|
| D-01 | **P1** | `(ho)/sales` — Ecomm by-channel | `c.cancelled` is never incremented; "Cancelled" and "Cancel %" are permanently `0` / `0.0%` |
| D-02 | **P1** | Repo-wide tooling | No ESLint config exists at all — `next lint` drops into its interactive setup wizard, so lint has never run |
| D-03 | **P1** | All 9 ag-grid tables | ag-grid theme is pinned to hard-coded **light-mode** hex; in dark mode every grid renders white-on-white |
| D-04 | **P1** | Every table, all pages | **Zero tables have a subtotal/total row.** `pinnedBottomRowData` appears nowhere in the codebase |
| D-05 | **P1** | Workspace vs Sales | Workspace is missing 5 of the 6 recent Sales features (comparison, grain toggle, faceting, product-attribute, network-total styling) |
| D-06 | **P2** | Whole app | **No `error.tsx` / `global-error.tsx` anywhere.** A throw outside a `SectionErrorBoundary` shows Next's raw error page |
| D-07 | **P2** | `(ho)/sales` period table | "Network total" separator is a `border-t-2` on a group banner + tinted rows — not a real total row; user says it doesn't meet standard |
| D-08 | **P2** | `(marketing)/campaigns` | Empty state never fires: `campaigns?.map(...) ?? <li>` — `[]` is not nullish, so an empty list renders a blank bordered box |
| D-09 | **P2** | `(ebo)/footfall`, `(ho)/targets` | Tables render an empty `<tbody>` with no empty-state row |
| D-10 | **P2** | `components/ui/FacetFilterBar.tsx:196` | `listMySavedViews().then()` with no `.catch()` and no unmount guard — unhandled rejection + setState-after-unmount |
| D-11 | **P2** | `(ebo)/my-store`, `(marketing)/campaigns` | Shipped as self-described "scaffold placeholder" pages in production nav-reachable route groups |
| D-12 | **P2** | Number formatting | `INR()`/`inr()` is copy-pasted verbatim in **16 files**; `FootfallMatrixCells` uses a different lakh format for the same quantity |
| D-13 | **P2** | `(ho)/targets` CategoryTracker | Numeric cells print raw integers with no thousands separator, unlike every other table |
| D-14 | **P3** | `(ho)/sales/EcommChannelFacetedTable.tsx:110` | `useMemo` deps include `channelHref`, redeclared every render → memo never caches |
| D-15 | **P3** | `components/ui/RowsPerPageSelect.tsx` | Dead code — exported, never imported anywhere |
| D-16 | **P3** | `package.json` | `react-hook-form` is a dependency but is **never imported**; all forms are hand-rolled |
| D-17 | **P3** | `AppShell.tsx` | Mobile nav is an unstyled wrapping link row; sidebar is `hidden md:flex` with no drawer/hamburger |
| D-18 | **P3** | Repo-wide | Hard-coded store exclusions `BO-004` / `BO-002` duplicated across 9 files, 3 of them uncommented |
| D-19 | **P3** | Repo path / `package.json` | `npm run typecheck` and `npm run lint` are unusable from this checkout path |
| D-20 | **P3** | `(replenishment)` redirect stubs | `/replenishment` and `/sale-stock-mix` redirect with no auth call, unlike `/network` and `/ecomm` which gate first |
| D-21 | **P2** | `(ho)/sales` product-attribute | "Returns" column renders `₹-1,23,456`; its source file's sign-convention header is stale and misleading after `014b1c5` |

---

## Findings

### D-01 — P1 — Ecomm "Cancelled" / "Cancel %" are permanently zero

**Where:** `web/app/(ho)/sales/page.tsx:876–911`

**Proof:**
```
876:  const byChannel = new Map<string, { orders: number; cancelled: number; units: number; net: number; mrp: number; discount: number }>();
877:  for (const r of daily) {
878:    const c = byChannel.get(r.channel) ?? { orders: 0, cancelled: 0, units: 0, net: 0, mrp: 0, discount: 0 };
879:    c.orders += Number(r.total_orders);
880:    c.units  += Number(r.units);
881:    c.net    += num(r.net_selling_value);
882:    c.mrp    += num(r.gross_mrp_value);
883:    c.discount += num(r.discount_value);
884:    byChannel.set(r.channel, c);
885:  }
...
910:    cancelled: c.cancelled,
911:    cancellationRate: c.orders > 0 ? (100 * c.cancelled) / c.orders : null,
```
Exhaustive grep for every occurrence of `cancelled` in the file confirms **no `c.cancelled +=` anywhere**:
```
page.tsx:876  (type decl)   page.tsx:878  (init to 0)
page.tsx:910  (read)        page.tsx:911  (read)
```
The only `CANCELLED` handling on the page is on a *different* aggregation, the SKU roll-up:
```
893:    if (l.status !== "CANCELLED") s.net += num(l.selling_price);
```
Both columns are rendered: `EcommChannelFacetedTable.tsx:102` (`Cancelled`) and `:103` (`Cancel %`).

**Impact:** Every Ecomm channel row shows `Cancelled = 0` and `Cancel %` — a wrong number with nothing visibly broken. `EcommChannelRow.cancellationRate` is `null` only when `orders === 0`, so real channels display a confident `0.0%`. The "Cancelled orders" and "Cancellation rate %" advanced filters (`EcommChannelFacetedTable.tsx:72–73`) also filter against a constant.

**Root cause:** `sales.vw_ecomm_daily` is selected as `channel, order_date, net_selling_value, gross_mrp_value, discount_value, units` (`page.tsx:208`) — there is no cancelled-order column in the select list, and the field was carried into the accumulator shape without a source.

**Recommended fix:** Either (a) add a `cancelled_orders` column to `vw_ecomm_daily` and to the select list, then `c.cancelled += Number(r.cancelled_orders)`; or (b) derive it from `vw_ecomm_order_lines` (which does carry `status`, already fetched at `page.tsx:855`) by counting distinct cancelled orders per channel; or (c) if neither source exists, **remove both columns** rather than ship a constant zero. Do not leave them.

---

### D-02 — P1 — ESLint is not configured; lint has never run

**Where:** `web/package.json` (`"lint": "next lint"`), no `.eslintrc*` / `eslint.config.*` present.

**Proof — `ls -a web/`:**
```
.design-scratch  .env.example  .env.local  .gitignore  .next  .vercel
README.md  app  check-warehouse.mjs  components  lib  middleware.ts
next-env.d.ts  next.config.mjs  node_modules  package-lock.json  package.json
postcss.config.js  scripts  supabase  tailwind.config.ts  tsconfig.json
tsconfig.tsbuildinfo  vercel.json
```
No eslint file. `grep -n eslint package.json` → no match (no `eslintConfig` key, no eslint devDependency).

**Actual output of `node ./node_modules/next/dist/bin/next lint`:**
```
? How would you like to configure ESLint? https://nextjs.org/docs/basic-features/eslint
❯  Strict (recommended)
   Base
   Cancel   ⚠ If you set up ESLint yourself, we recommend adding the Next.js ESLint plugin.
```
It never lints — it prompts. In CI (non-TTY) this either hangs or exits without checking anything.

**Impact:** No `react-hooks/exhaustive-deps`, no `@next/next/no-img-element`, no unused-var detection. The codebase contains **seven `// eslint-disable-next-line` comments** suppressing rules from a linter that isn't installed — so those suppressions were written blind and have never been validated:
```
app/(workspace)/workspace/WorkspaceFiltersBar.tsx:103   react-hooks/exhaustive-deps
components/ui/SectionErrorBoundary.tsx:31               no-console
components/ui/StoreFilter.tsx:226                       react-hooks/exhaustive-deps
components/ui/TopProgressBar.tsx:75                     react-hooks/exhaustive-deps
components/ui/TopProgressBar.tsx:148                    react-hooks/exhaustive-deps
lib/perf/timing.ts:17                                   no-console
lib/perf/timing.ts:33                                   no-console
```

**Recommended fix:** `npx next lint --strict` once to generate `.eslintrc.json`, add `eslint` + `eslint-config-next` to devDependencies, then fix or re-justify each existing disable comment.

---

### D-03 — P1 — Every ag-grid table renders light-themed in dark mode

**Where:** `web/components/ui/DataGrid.tsx:23–37`

**Proof:**
```tsx
23: const appQuartzTheme = themeQuartz.withParams({
24:   accentColor: "#111113",
25:   backgroundColor: "#ffffff",
26:   foregroundColor: "#111113",
27:   borderColor: "#e6e6e8",
28:   headerBackgroundColor: "#f1f1f2",
29:   headerTextColor: "#46464b",
30:   oddRowBackgroundColor: "#ffffff",
```
The file's own header comment admits it: *"deliberately matching the light-mode token values — they must be updated BY HAND whenever globals.css's palette changes"*.

Dark mode is a real, shipped feature: `app/layout.tsx:14–21` applies `data-theme="dark"` before first paint, `components/ui/ThemeToggle.tsx:20` sets it, and `app/globals.css:81` defines `:root[data-theme="dark"] { … }`. There is **no** `--ag-` override or `ag-theme` rule in `globals.css` (grep returned nothing).

**Impact:** All 9 `<DataGrid>` call sites render a white grid with near-black text inside a dark page:
`EcommChannelFacetedTable.tsx:118`, `PeriodSalesFacetedTable.tsx:218`, `ProductAttributeSalesTable.tsx:301`, `AttributeMixGrid.tsx:88`, `AttributeReplenishmentGrid.tsx:49`, `ReplenishmentGrid.tsx:177`, `SaleStockMixGrid.tsx:122`, `StockVsCapacityGrid.tsx:56`, `StoreLeagueDrilldown.tsx:121`.

Worse, `PeriodSalesFacetedTable.tsx:233` injects `background: "var(--surface-2)"` inline for Network-total rows — that CSS var *does* flip with the theme, so in dark mode those rows go dark while the rest of the grid stays white. Same for `StockVsCapacityGrid`'s `cellClass` status colours.

**Root cause:** ag-grid's Theming API evaluates params in JS and cannot read Tailwind/CSS custom properties, so the author pinned literals.

**Recommended fix:** ag-grid v36 supports `themeQuartz.withPart(colorSchemeDark)`. Read the active theme in `DataGrid` (a `useSyncExternalStore` on the `data-theme` attribute, or lift it to a context set by `ThemeToggle`) and pick between a light and a dark `withParams` object. One file, one fix, all nine grids.

---

### D-04 — P1 — No table anywhere has a subtotal / total row

**Where:** every table in the app. See the full **Table inventory** section below.

**Proof:** exhaustive grep across `app/ components/ lib/`:
```
grep -rn "pinnedBottomRow|pinnedTopRow|tfoot|grandTotal|Grand total|subtotal"
→ app/(data-upload)/data-upload/process-button.tsx:194   "Total rows"  (a <dt> label, not a table row)
→ app/(stock-details)/stock-details/page.tsx:386          a code comment
→ lib/erpReports/common.ts:23, parseMasterWorkbook.ts:208 parsing/SKIPPING the ERP's own embedded subtotals
→ lib/stockDetails/aggregate.ts:96,226                    grandTotal used only as a share-% denominator
```
`pinnedBottomRowData` — **0 hits**. `<tfoot>` — **0 hits**.

The only aggregate figures shown anywhere are *outside* tables: `movement/page.tsx:512` prints a prose line (`Total sales in scope: … units`), and `CategoryTracker.tsx:80` prints `Target … · MTD …` in the section header.

**Impact:** This is the user's stated working standard. 24 tables carrying 100+ numeric columns between them, none of which can be read for a total without exporting.

**Recommended fix:**
1. **ag-grid tables (9):** add a `pinnedBottomRowData` prop threaded through `components/ui/DataGrid.tsx`. Compute one synthetic row per table from the same `filtered` array already in scope, so the total follows the active facet filters. Per-column aggregate is listed in the Table inventory below.
2. **Plain `<table>` tables (15):** add a `<tfoot>` with the same rule.
3. **Crucial arithmetic rule:** ratio columns (`Discount %`, `ATV`, `UPT`, `Cancel %`, `Conv`, `Ach%`, `Share`, `Cover`, `Sale Mix`, `Stock Mix`) must be **recomputed from the summed numerator and denominator**, never averaged across rows. E.g. footer `ATV = Σnet / Σbills`, not `avg(row.atv)`. Averaging them is the same class of error `rollUpCore`'s own header comment (`sales/page.tsx:130–136`) warns against.
4. Change columns (`Net change`, `Qty change`, `WOW`) should render `—` in the footer, not a number — a period-over-period delta has no meaningful column sum.

---

### D-05 — P1 — Workspace has not received the recent Sales features

See the dedicated **Sales → Workspace parity diff** section below for the itemised, file-by-file breakdown.

---

### D-06 — P2 — No route-level error boundary anywhere in the app

**Where:** `web/app/` — all route groups.

**Proof:**
```
find app -name "error.tsx" -o -name "global-error.tsx" -o -name "not-found.tsx"
→ (no results)
```
For contrast, `loading.tsx` exists in 9 of 10 route groups.

`components/ui/SectionErrorBoundary.tsx` exists and is used well — but only in 4 files (`sales/page.tsx` ×5, `targets/page.tsx` ×2, `movement/page.tsx` ×2, `stock-details/page.tsx` ×1). Everything *outside* a `<SectionErrorBoundary>` on those pages, and **every** page that uses none, has no recovery UI.

Pages with **zero** error handling: `integrations`, `users`, `configurations`, `data-upload`, `footfall`, `my-store`, `campaigns`, `workspace`, `login`, `app/page.tsx`, `sh-test`.

**Impact:** A failed Postgres query in e.g. `WorkspacePage`'s `Promise.all` (`workspace/page.tsx:58`) or `UsersPage` propagates to Next's default error page — full white screen, no nav, no retry, "Application error: a server-side exception has occurred" in production. `workspace/page.tsx` is the highest risk: `renderSalesComponents.tsx:132` and `:172` **deliberately `throw new Error(...)`** when a governed filter can't be applied, and nothing catches it.

**Recommended fix:** Add `app/error.tsx` (root, client component, `{ error, reset }`) plus `app/global-error.tsx` for layout-level failures. Optionally per-group `error.tsx` so the AppShell survives. Wrap `WorkspaceGridClient`'s children in `SectionErrorBoundary` per card so one broken component doesn't blank the whole grid.

---

### D-07 — P2 — "Sales value & quantity by period — EBO": row separator is not a total

**Where:** `web/app/(ho)/sales/PeriodSalesFacetedTable.tsx:139–157` and `:231–235`; rendered from `sales/page.tsx:497`.

**Proof — what exists today:**
```tsx
143:  const network = g.label === NETWORK_LABEL;
144:  return (
145:    <div className={`flex h-full items-center gap-2 bg-surface-2 px-1 text-[12px] ${
147:      network ? "border-t-2 border-line font-bold text-ink" : "font-semibold text-ink-2"
148:    }`}
```
```tsx
231:  getRowStyle={(p) =>
232:    isNetworkRow(p.data) && !isGroupHeader(p.data)
233:      ? { background: "var(--surface-2)", fontWeight: 600 }
234:      : undefined
235:  }
```
and the hoist that puts the bucket last:
```tsx
45: function networkGroupLast(rows: GridRow[]): GridRow[] { … }
```

**What this actually is:** the store list is grouped (`state.groupBy = ["store"]`, line 97), each group getting a full-width `colSpan={COL_COUNT}` banner row. "Network total" is one more **group of period rows**, hoisted to the bottom and given a 2px top border plus a tint. It is *n* more rows, not a summary line.

**Why it doesn't meet the standard:**
- The 11 numeric columns (`Net sales`, `Gross`, `Bills`, `Qty`, `ATV`, `Discount %`, both change columns) have **no footer total** for any store block, and none for the table.
- With `groupBy` cleared from the filter bar the border disappears entirely and Network-total rows interleave with store rows, distinguished only by a tint.
- `COL_COUNT = 11` (line 29) is a hand-maintained literal that must match the `columnDefs` array length at lines 131–185. It currently does. It is one column-add away from silently mis-spanning.

**Recommended fix:**
1. Add `pinnedBottomRowData` with a real grand-total row (see D-04 for the ratio rule).
2. Replace the tint-only store divider with a per-group total row. ag-grid Community has no `groupIncludeFooter`, so build it the way group headers already are — in `buildGroupedRows`, emit a `__groupFooter` row after each bucket and give it the same `colSpan`/`cellRenderer` treatment the header gets.
3. Derive `COL_COUNT` from `columnDefs.length` instead of hard-coding `11`.

---

### D-08 — P2 — Campaigns empty state never renders

**Where:** `web/app/(marketing)/campaigns/page.tsx:31–38`

**Proof:**
```tsx
31: <ul className="mt-4 divide-y divide-line-soft border border-line-soft">
32:   {campaigns?.map((c) => (
...
37:   )) ?? <li className="px-3 py-2 text-sm text-ink-3">No campaigns yet.</li>}
38: </ul>
```
When the query succeeds with zero rows, `campaigns` is `[]` — not `null`/`undefined`. `[].map(...)` returns `[]`, which is **not** nullish, so `??` does not fire. React renders an empty array → an empty bordered box with no text.

The fallback only fires if the query errors (`data: null`), which is exactly the case where "No campaigns yet." is the *wrong* message.

**Recommended fix:** `{(campaigns ?? []).length === 0 ? <li>No campaigns yet.</li> : campaigns!.map(...)}`. Same idiom is already used correctly at `data-upload/page.tsx:48`.

---

### D-09 — P2 — Tables with no empty-state row

**Where:**
- `web/app/(ebo)/footfall/page.tsx:143–163` — `{(recent ?? []).map(...)}` with no `length === 0` branch. An `<tbody>` with zero `<tr>`.
- `web/app/(ho)/targets/CategoryTracker.tsx:94–125` — `{rows.map(...)}`, same.

**Proof (footfall):**
```tsx
142: <tbody>
143:   {(recent ?? []).map((r) => (
...
161:   ))}
162: </tbody>
```
No `colSpan` fallback row, unlike e.g. `AgentSalesFacetedTable.tsx:102–106` or `WeeklyRowDrilldown.tsx:85–88` which do it correctly.

**Impact:** A new store with no footfall history, or a date range with no data, shows a header row floating above nothing. First-use experience for the primary EBO-manager screen.

**Recommended fix:** add the same `{rows.length === 0 && (<tr><td colSpan={n} …>No … in this range.</td></tr>)}` pattern used elsewhere in the codebase.

---

### D-10 — P2 — Unhandled promise rejection + setState-after-unmount in the shared filter bar

**Where:** `web/components/ui/FacetFilterBar.tsx:196–198`

**Proof:**
```tsx
196:  useEffect(() => {
197:    listMySavedViews(pageKey).then((views) => setSavedViews(views.map((v) => ({ id: v.id, name: v.name, state: v.state }))));
198:  }, [pageKey]);
```
Three problems in one line:
1. No `.catch()` — if the Server Action throws (auth expiry, DB down), it's an unhandled rejection. There is no `error.tsx` (D-06) and the effect is outside any error boundary, so this is a silent console-only failure.
2. No cancellation flag — `pageKey` changes on every grain toggle in `PeriodSalesFacetedTable.tsx:207` (`pageKey={`${PAGE_KEY}_${grain}`}`), so rapid Daily→Weekly→Monthly clicking can land an older response last (stale saved-views list).
3. No unmount guard.

**Impact:** `FacetFilterBar` is the shared filter bar for 6 tables. A user toggling grain quickly can see another grain's saved views.

**Recommended fix:**
```tsx
useEffect(() => {
  let alive = true;
  listMySavedViews(pageKey)
    .then((views) => { if (alive) setSavedViews(views.map(...)); })
    .catch(() => { if (alive) setSavedViews([]); });
  return () => { alive = false; };
}, [pageKey]);
```

---

### D-11 — P2 — Two placeholder pages ship in production nav

**Where:**
- `web/app/(ebo)/my-store/page.tsx:44–51`:
  ```tsx
  44: <p className="mt-6 text-sm text-ink-3">
  45:   Scaffold placeholder — the full screen (diagnosis, action buttons,
  46:   pending items) is mock screen 04; the diagnosis card should call
  47:   <code …>supabase.schema('ops').rpc('fn_diagnose_store')</code>.
  ```
- `web/app/(marketing)/campaigns/page.tsx:25–30`:
  ```tsx
  25: <p className="mt-1 text-[12.5px] text-ink-3">
  26:   Placeholder list — the full performance view (screen 07: delivery
  27:   funnel, failure-reason breakdown, store impact) reads from
  28:   marketing.vw_campaign_metrics / …
  ```

**Impact:** Internal implementation notes are visible to end users. Neither page is currently in `NAV_LINKS` (`AppShell.tsx:60–70`) — there is no `/my-store` or `/campaigns` entry — but both are reachable by URL and pass their route-group role gate. `campaigns/page.tsx` additionally has **no page-level auth call at all** (only `(marketing)/layout.tsx`'s `requireRole("marketing","ho_admin","super_admin")`), inconsistent with every other page which re-checks with `requirePageAccess`.

**Recommended fix:** finish them, or move the notes into a code comment and render a neutral "Coming soon" state. Add `requirePageAccess("campaigns")` for consistency with the rest of the app.

---

### D-12 — P2 — `INR()` duplicated 16 times, with one divergent variant

**Where:** the identical body `(n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;` appears verbatim in:
```
app/(ebo)/footfall/footfall-counter.tsx:9
app/(ho)/network/AgentSalesFacetedTable.tsx:19
app/(ho)/network/StoreDiagnosisFacetedTable.tsx:18
app/(ho)/sales/EcommChannelFacetedTable.tsx:17
app/(ho)/sales/PeriodSalesFacetedTable.tsx:20
app/(ho)/sales/ProductAttributeSalesTable.tsx:30
app/(ho)/sales/page.tsx:116
app/(workspace)/workspace/StoreLeagueDrilldown.tsx:27
app/(workspace)/workspace/WeeklyRowDrilldown.tsx:21
components/ui/ComparisonTrendChart.tsx:33   (as `inr`)
components/ui/HourlyBarChart.tsx:13         (as `inr`)
components/ui/TrendChart.tsx:17             (as `inr`)
lib/alerts/mailer.ts:35
lib/workspace/renderFootfallComponents.tsx:68
lib/workspace/renderReplenishmentComponents.tsx:53
lib/workspace/renderSalesComponents.tsx:244
```
plus `fmt` (unit-count variant) in 7 more files, and `PCT` in 2.

**The divergent one — `components/ui/FootfallMatrixCells.tsx:23`:**
```tsx
23: const INR_SHORT = (n: number) => (n >= 100000 ? `₹${(n / 100000).toFixed(2)}L` : `₹${Math.round(n).toLocaleString("en-IN")}`);
```
This is the *only* place in the app that uses Indian lakh notation. It renders inside the footfall matrix on `(ho)/sales`, directly above `StoreDiagnosisFacetedTable` which prints the same class of figure as `₹12,34,567`. Two formats for the same quantity, adjacent on one screen.

**Impact:** Consistency risk on every future change; a currency-format decision (symbol, rounding, lakh/crore) currently requires 16 edits. Note `Math.round()` is applied *at display only*, after aggregation — that part is correct throughout.

**Recommended fix:** one `lib/format.ts` exporting `INR`, `INR_SHORT`, `PCT`, `NUM`. Decide once whether lakh notation is the house style, and apply it or drop it.

---

### D-13 — P2 — Targets tracker prints unformatted integers

**Where:** `web/app/(ho)/targets/CategoryTracker.tsx:105–109`

**Proof:**
```tsx
105: <td className="px-2 py-1.5 text-right text-ink-3">{mtdTarget}</td>
106: <td className="px-2 py-1.5 text-right">{r[actualKey]}</td>
107: <td className="px-2 py-1.5 text-right">{cum}</td>
```
and the header summary at line 80: `Target {monthlyTarget} · MTD {cumSoFar} ({pct(...)})`.

Raw JS number-to-string. Every other numeric table in the app runs values through `toLocaleString("en-IN")` — e.g. `ProductAttributeSalesTable.tsx:189`, `StockVsCapacityGrid.tsx:10`, `ReplenishmentGrid.tsx:34`.

**Impact:** A monthly target of 125000 renders `125000`, not `1,25,000`. These are quantity columns on a page whose whole purpose is target-vs-actual reading.

**Recommended fix:** route through the shared `NUM` helper from D-12's fix.

---

### D-14 — P3 — `useMemo` in `EcommChannelFacetedTable` never caches

**Where:** `web/app/(ho)/sales/EcommChannelFacetedTable.tsx:56–64` and `:110`

**Proof:**
```tsx
56:  function channelHref(target: string | null) {   // ← new identity every render
...
84:  const columnDefs = useMemo<ColDef<EcommChannelRow>[]>(
85:    () => [ … ],
110:    [activeChannel, channelHref]
111:  );
```
`channelHref` is a plain function declaration inside the component body, so its reference changes on every render, so the dependency array always differs, so `columnDefs` is rebuilt every render — and ag-grid re-diffs its columns each time.

**Impact:** Minor. Wasted work on a small table; would matter more if `rows` grew.

**Recommended fix:** wrap `channelHref` in `useCallback([pathname, searchParams])`, or (simpler) drop it from the deps and reference it via a ref — the current pattern is strictly worse than no `useMemo` at all.

---

### D-15 — P3 — `RowsPerPageSelect` is dead code

**Where:** `web/components/ui/RowsPerPageSelect.tsx` (47 lines)

**Proof:** `grep -rn "RowsPerPageSelect" app` → **no results**. The only mention is its own definition.

Its header comment references `mix_perPage/mix_page` URL params — a server-side pagination scheme that `ReplenishmentGrid.tsx:67` and `SaleStockMixGrid.tsx:32` both explicitly document as removed ("Display filtering/search/pagination is NOT server-side anymore for the Movement page").

**Recommended fix:** delete the file, or wire it into the grids if row-cap control is still wanted (see also the note on large-data behaviour in the Page × State matrix).

---

### D-16 — P3 — `react-hook-form` is an unused dependency

**Where:** `web/package.json` — `"react-hook-form": "^7.53.0"`

**Proof:** `grep -rn "react-hook-form|useForm" app components lib` → **no results**.

Every form in the app is hand-rolled `useState` + Server Action / `fetch`:
`logic-erp-form.tsx`, `invite-user-form.tsx`, `alert-mailer-form.tsx`, `fresh-disc-source-form.tsx`, `upload-form.tsx`, `monthly-target-form.tsx`, `bulk-upload-form.tsx`, `login/page.tsx`.

**Impact:** Ships an unused ~25KB library. (Not a correctness bug — see the Forms notes under VERIFIED CORRECT; the hand-rolled forms are actually well-behaved.)

**Recommended fix:** remove the dependency, or adopt it consistently. Do not leave it half-declared.

---

### D-17 — P3 — Mobile navigation is a raw wrapping link row

**Where:** `web/components/ui/AppShell.tsx:186–196`

**Proof:**
```tsx
186: {/* Mobile: sidebar collapses to a slim link row under the top bar. */}
187: <nav className="fixed inset-x-0 top-14 z-40 flex flex-wrap gap-x-3 gap-y-1 border-b border-line-soft bg-sidebar-bg px-4 py-2 text-[12.5px] text-ink-2 md:hidden">
188:   {links.map((l) => (
189:     <a key={l.href} href={l.href} className="hover:text-ink">{l.label}</a>
```
The desktop sidebar is `hidden … md:flex` (line 173). There is no hamburger, no drawer, and no active-state indicator on mobile.

**Impact:** With 10 nav links this row wraps to 2–3 lines on a phone, pushing content down by an unbounded amount — and the content area's top padding is a fixed `pt-14` (line 199), which only accounts for the top bar, **not** this nav. So on mobile the first lines of every page render underneath the nav row.

Also `<a>` not `<Link>` — every mobile nav click is a full document reload, and there's no `aria-current` on the active link.

**Recommended fix:** collapsible drawer behind a hamburger, or at minimum give the nav a fixed height with `overflow-x-auto` and bump the content padding to match on `<md`.

---

### D-18 — P3 — Hard-coded store exclusions duplicated across nine files

**Where:** the identical predicate `.filter((s) => s.store_id !== "BO-004" && s.store_id !== "BO-002")` appears in **nine** files:
```
app/(admin)/users/page.tsx:119                   (+ explanatory comment at :116)
app/(ebo)/footfall/page.tsx:85                   (+ explanatory comment at :82)
app/(ho)/sales/page.tsx:1114                     ← no comment
app/(ho)/targets/page.tsx:377                    (+ explanatory comment at :374)
app/(stock-details)/stock-details/page.tsx:319   (+ explanatory comment at :316)
app/(workspace)/workspace/page.tsx:66            ← no comment
lib/replenishment/compute.ts:230                 (+ explanatory comment at :227)
lib/replenishment/mix.ts:150                     (+ explanatory comment at :147)
lib/workspace/renderStockComponents.tsx:60       ← no comment
```
Five carry a copy of the same comment ("BO-004 (Phoenix Palassio, Lucknow) and BO-002 (Baramati, 0091) are both discontinued/not-yet-operational"); three carry none.

**Impact:** A third discontinued store — or reinstating either of these two — is a nine-file edit that is easy to do incompletely, and the three uncommented copies give a reader no idea why those IDs are special. A partial edit would show different store sets on different pages, with nothing visibly broken.

**Recommended fix:** a single exported `EXCLUDED_STORE_IDS` (or, better, an `is_active` flag on `core.stores`).

---

### D-19 — P3 — `npm run typecheck` / `npm run lint` cannot run from this path

**Where:** repo directory name contains `&`.

**Proof (verbatim):**
```
> ebo-sales-intelligence@0.1.0 typecheck
> tsc --noEmit
'Marketing' is not recognized as an internal or external command, operable program or batch file.
Error: Cannot find module 'D:\Py\typescript\bin\tsc'
```
npm resolves the script through `cmd.exe`, where `&` is a command separator; the path splits at `Sales &` / `Marketing dashboard_Test`.

**Impact:** CI, pre-commit hooks and any contributor on this checkout silently get exit-code-0 "success" from a script that never ran the tool. Note the failing run above **still exited 0**.

**Recommended fix:** rename the directory (remove `&`), or set `"script-shell"` in `.npmrc` to a POSIX shell, or invoke the binaries directly.

---

### D-20 — P3 — Two redirect stubs skip their auth call

**Where:** `web/app/(replenishment)/replenishment/page.tsx:7–9` and `web/app/(replenishment)/sale-stock-mix/page.tsx:7–9`

**Proof:**
```tsx
7: export default function ReplenishmentRedirect() {
8:   redirect("/movement?tab=replenishment");
9: }
```
Compare the two *other* redirect stubs, which gate first:
```tsx
// app/(ho)/network/page.tsx:22
await requirePageAccess("network");
// app/(ecomm)/ecomm/page.tsx:22
await requirePageAccess("ecomm");
```

**Impact:** Low — `(replenishment)/layout.tsx:5` runs `requirePageAccess("replenishment")` before the page renders, so access is enforced. But the *denial reason* attributed to the user differs (they get bounced from the layout with the group's page key rather than the specific one), and the inconsistency invites a future copy-paste of the ungated form into a group whose layout is coarser.

**Recommended fix:** add the matching `await requirePageAccess("replenishment")` to both stubs, for symmetry with `/network` and `/ecomm`.

### D-21 — P2 — "Returns" column now renders a negative rupee value, and its source file's header is stale post-`014b1c5`

**Where:** `web/lib/sales/attributeBreakdown.ts:294–296` and `:22–44`; rendered at `web/app/(ho)/sales/ProductAttributeSalesTable.tsx:196`.

**Proof — the accumulator:**
```ts
280:    const net = numOf(line.net_amount);
281:    const gross = numOf(line.gross_amount);
282:    // Unsigned across every bill_type — see this file's header …
284:    bucket.net += net;
285:    bucket.gross += gross;
286:
287:    if (line.bill_type === "SALE") { … }
294:    } else if (line.bill_type === "RETURN") {
295:      bucket.returnsValue += net;
296:    }
```

**Proof — the render, with no sign handling:**
```tsx
196:  { field: "returnsValue", headerName: "Returns", flex: 0.7, ...right, valueFormatter: (p) => INR(p.value) },
```

**Proof — the data is now SIGNED.** HEAD commit `014b1c5` ("Fix RETURN sign convention — Sales/Targets were ~8% too high") establishes:
> *"raw_logic.sales_transactions stores amounts and quantities already SIGNED (a RETURN row is negative) … the whole sales.vw_ebo_* chain relies on [that], since it sums net_amount as stored with no sign logic of its own."*

It also removed the opposing convention: *"lib/replenishment/compute.ts and lib/replenishment/mix.ts applied their own `sign = bill_type === 'RETURN' ? -1 : 1` on top, which double-negated the already-negative Excel-era rows."*

**Two consequences:**

1. **Display (real, user-visible).** Because `net_amount` on a RETURN row is negative, `bucket.returnsValue` accumulates a negative total and `INR()` renders it verbatim — a column headed **"Returns"** shows **`₹-1,23,456`**. Every other Returns figure on the page is presented as a positive magnitude (e.g. the ECOM Returns table at `sales/page.tsx:989` counts rows). This is a double-negative to read: a *larger* return volume shows as a *smaller* number.

2. **Stale, actively misleading documentation.** The file header (`:22–44`) is now wrong in two places and carries a "do not change this" instruction:
   - `:26` describes `compute.ts`/`mix.ts` as applying `sign = bill_type === "RETURN" ? -1 : 1` — **that code was deleted in `014b1c5`.** The two conventions it says "genuinely disagree" no longer disagree.
   - `:30` and `:282` both claim the sums are **"UNSIGNED across every bill_type"**. With signed source data, `bucket.net += net` now *subtracts* returns. The arithmetic is correct (it matches `vw_ebo_sales_daily`, which also sums as-stored), but for the opposite reason to the one documented.
   - `:41–44` instructs: *"Do not 'fix' this to sign-adjust without also changing vw_ebo_sales_daily and re-running web/scripts/verify-metrics.mjs."* That advice is still correct, but a reader arriving via the stale premise above will reach it having already been misled about what the code does.

**Impact:** The arithmetic in `net`, `gross`, `discount`, `atv` and `netSharePct` is **correct** — no wrong totals. The defect is (a) one column displayed with an unhelpful sign, and (b) a header comment that will mislead the next person to touch the file, in exactly the area that has already produced one ~8%-wrong-numbers incident.

**Recommended fix:**
1. Display: `valueFormatter: (p) => INR(Math.abs(p.value))` — or rename the column to "Returns (net impact)" and keep the sign. Pick one deliberately; do not leave a negative under a bare "Returns" header.
2. Rewrite the `attributeBreakdown.ts` header to describe the post-`014b1c5` world: source rows are signed, sums are taken as-stored, and that is why no sign logic appears here.
3. Same review pass over `lib/sales/aggregate.ts`, which the same header names as "ground truth".

**Encoding note:** `lib/sales/attributeBreakdown.ts` is reported as `data` (not text) by `file(1)` and needs `grep -a` to search. It contains non-ASCII bytes (em-dashes and `₹` in comments) with no BOM; some tools will treat it as binary. Worth normalising.

---

## Page × State matrix

Legend — **Loading**: `L` = route `loading.tsx` bar, `S` = in-page Suspense + shape-matched skeleton, `—` = neither.
**Progress indicator**: `TPB` = global `TopProgressBar` (root layout), `RLB` = route `loading.tsx` → `RouteLoadingBar`.

| Page | Loading | Empty | Error | No-permission | Large-data | Progress indicator | Notes |
|---|---|---|---|---|---|---|---|
| `(admin)/integrations` | `L` only | n/a (single form) | ❌ none | ✅ `requirePageAccess("integrations")` + `requireRole("super_admin")` in layout | n/a | TPB + RLB | Whole page blocks on one `maybeSingle()`. No `SectionErrorBoundary`. |
| `(admin)/users` | `L` only | ✅ `UsersAdmin.tsx:317` colSpan row; `:274` per-cell "no BU" | ❌ none | ✅ layout `requireRole("super_admin")` + `requirePageAccess("users")`; per-action re-check in `actions.ts` | ⚠️ full user list rendered, no virtualization/pagination | TPB + RLB | Best-handled admin page: `useTransition` (`:100`) gates every mutation. |
| `(configurations)/configurations` | `L` only | n/a | ❌ none | ✅ layout `requireRole` + `requirePageAccess("configurations")` | n/a | TPB + RLB | `alert-mailer-form.tsx` has a `busy` flag on every control. |
| `(data-upload)/data-upload` | `L` only | ✅ `page.tsx:48` `t.noFilesUploadedYet` | ❌ none (upload form has its own error state, `upload-form.tsx:127`) | ✅ layout `requirePageAccess("data-upload")` + `data-upload.process.admin` feature gate (`:89`) | ✅ direct-to-storage XHR, 50MB, real % progress | TPB + RLB + **per-upload % bar** | Strongest state handling in the app. |
| `(ebo)/footfall` | `L` only | ❌ **D-09** — empty `<tbody>` | ❌ none | ✅ `requirePageAccess("footfall")`; ✅ **zero-store state** at `:29` (`t.noStoreAssigned`) | ⚠️ unbounded date range → unbounded rows | TPB + RLB | Counter debounces saves (700ms) with a real cleanup (`footfall-counter.tsx:88`). |
| `(ebo)/my-store` | `L` only | ✅ `week ? … : "—"` + `tone="muted"` | ❌ none | ✅ `requireRole("ebo_manager")`; ⚠️ no explicit UI when `storeIds[0]` is undefined — silently shows `—` | n/a | TPB + RLB | **Placeholder page — D-11.** |
| `(ecomm)/ecomm` | ❌ **no `loading.tsx` in this group** | n/a | ❌ none | ✅ `requireRole` (layout) + `requirePageAccess("ecomm")` before redirect | n/a | TPB only | Pure redirect to `/sales?bu=ecomm`. Missing `loading.tsx` is harmless here but the group is inconsistent with the other 9. |
| `(ho)/network` | `L` | n/a | ❌ none | ✅ `requirePageAccess("network")` before redirect | n/a | TPB + RLB | Pure redirect to `/sales`. |
| `(ho)/sales` | `L` + **`S` ×5** | ✅ per-section: `:284` no-trend, `:626` no-scheme, `:766` no-footfall, `:958` no-SKU, `:977` no-returns, grid overlays | ✅ **`SectionErrorBoundary` ×5** (`:1149, :1170, :1180, :1190, :1200`) | ✅ `requireRole` ×5 + per-vertical `resolveViewScope`; ✅ zero-vertical state at `:263` | ✅ `fetchAllRows` paginates the line-grain query (`:557`); ag-grid virtualizes | TPB + RLB + 5 skeletons | Reference implementation for the rest of the app. |
| `(ho)/targets` | `L` + **`S` ×2** | ✅ `:217` `rows.length === 0` | ✅ `SectionErrorBoundary` ×2 (`:405, :422`) | ✅ `requirePageAccess("targets")` | ⚠️ CategoryTracker renders a full month, fine | TPB + RLB + 2 skeletons | Tracker table itself lacks an empty row (**D-09**). |
| `(marketing)/campaigns` | `L` only | ❌ **D-08** — fallback never fires | ❌ none | ⚠️ **layout-only** `requireRole`; no `requirePageAccess` | ❌ unbounded `select()` with no limit | TPB + RLB | **Placeholder page — D-11.** |
| `(replenishment)/movement` | `L` + **`S` ×2** | ✅ grid overlays + `:512` scope summary | ✅ `SectionErrorBoundary` ×2 (`:624, :637`) | ✅ `requirePageAccess("replenishment")` + **two separate feature gates** (`:572–573`); ✅ explicit "no access to either section" state at `:586` | ⚠️ client-side filter over full row set (server pagination was removed) | TPB + RLB + 2 skeletons | Best no-permission handling in the app. |
| `(replenishment)/replenishment` | `L` | n/a | ❌ none | ⚠️ layout-only — **D-20** | n/a | TPB + RLB | Redirect stub. |
| `(replenishment)/sale-stock-mix` | `L` | n/a | ❌ none | ⚠️ layout-only — **D-20** | n/a | TPB + RLB | Redirect stub. |
| `(stock-details)/stock-details` | `L` + `S` ×1 | ✅ `:212` "No stock snapshot loaded yet…" with a link to Data Upload; `:419` colSpan row | ✅ `SectionErrorBoundary` (`:351`) | ✅ `requirePageAccess("stock-details")`; edit controls role-gated separately (`capacity-editor.tsx`) | ⚠️ header comment notes unfiltered fetch can exceed 6s | TPB + RLB + skeleton | Excellent first-use empty state. |
| `(workspace)/workspace` | `L` only + `LazyMount` per card | ✅ per-component ("No … in this window"); ✅ unwired-component message `:241` | ❌ **none** — and `renderSalesComponents.tsx:132/:172` deliberately `throw` | ✅ layout + page `requirePageAccess("workspace")`; ✅ role-filtered picker (`:129`) | ✅ `LazyMount` defers mount; ⚠️ **all data still fetched eagerly** (`:190` comment admits this) | TPB + RLB | **No Suspense boundary at all** — the whole page blocks on the slowest of 6 family fetches. Highest crash risk (D-06). |
| `login` | ❌ no `loading.tsx` at `app/` root | n/a | ✅ renders `searchParams.error` (`:17`, `:22`) | n/a (public) | n/a | **TPB only** (fires on form submit — `TopProgressBar.tsx:129`) | Native `required` validation; no client-side submitting state on the button. |
| `app/page.tsx` | ❌ no root `loading.tsx` | n/a | ✅ redirects to `/login?error=not_provisioned` (`:28`) | ✅ redirects unauthenticated to `/login` | n/a | TPB only | Pure server redirect resolver. |
| `sh-test` | ❌ none | ✅ gated on `session` (`:34`) | ❌ none | ⚠️ **excluded from middleware** (`middleware.ts:26`) — its own Keycloak session only | n/a | **none** (outside AppShell) | Self-described "not a real page"; header says delete after migration. Dumps raw JSON incl. session claims. |

**Gaps summarised:**
- **No `error.tsx` on any of the 19.** (D-06)
- `(ecomm)` is the only route group without `loading.tsx`; `login`, `app/page.tsx`, `sh-test` have none because `app/` has no root `loading.tsx`.
- Pages with **no** in-page Suspense/skeleton: `integrations`, `users`, `configurations`, `data-upload`, `footfall`, `my-store`, `campaigns`, **`workspace`**, `login`, `page.tsx`, `sh-test`.

---

## Table inventory

24 tables. "Has subtotal?" is **No** for every single one (D-04). Suggested aggregate per numeric column below — ratios must be recomputed from summed numerator/denominator, never averaged.

### ag-grid tables (virtualized; sortable per-column; no pagination anywhere)

| Page | Table name (file) | Numeric cols | Has subtotal? | Suggested subtotal per col | Sortable | Paginated | Sticky header | H-overflow | Empty / Loading |
|---|---|---|---|---|---|---|---|---|---|
| `(ho)/sales` | **Sales value & quantity by period — EBO** `PeriodSalesFacetedTable.tsx` | Net sales, Net change %, Gross, Discount %, Bills, Qty, Qty change %, ATV | **No** | Net **sum**; Gross **sum**; Bills **sum**; Qty **sum**; Discount % = Σdiscount/Σgross; ATV = Σnet/Σbills; both change cols → `—` | ✅ all | ❌ (virtualized) | ✅ ag-grid native | ✅ ag-grid native | `overlayNoRowsTemplate` `:237`; page-level skeleton |
| `(ho)/sales` | **By channel — ECOM** `EcommChannelFacetedTable.tsx` | Orders, Cancelled, Cancel %, Units, Net value, MRP value, Discount % | **No** | Orders **sum**; Cancelled **sum**; Cancel % = Σcancelled/Σorders; Units **sum**; Net **sum**; MRP **sum**; Discount % = Σdisc/ΣMRP | ✅ all | ❌ | ✅ | ✅ | `overlayNoRowsTemplate` `:139` |
| `(ho)/sales` | **Sales by product attribute — EBO** `ProductAttributeSalesTable.tsx` | Net sales, Share, Qty, Bills, ATV, UPT, Discount %, Returns | **No** | Net **sum**; Share → `100%`; Qty **sum**; Bills → `—` (see caveat below); ATV = Σnet/Σbills; UPT = Σqty/Σbills; Discount % recomputed; Returns **sum** | ✅ all | ❌ | ✅ | ✅ | grid overlay |
| `(replenishment)/movement` (mix tab) | **Attribute mix** `AttributeMixGrid.tsx` | Sales, Sale Mix, Store SOH, WH SOH, Stock Mix, Mix Gap | **No** | Sales **sum**; Store/WH SOH **sum**; Sale Mix & Stock Mix → `100%`; Mix Gap → `0` or `—` | ✅ | ❌ | ✅ | ✅ | grid overlay |
| `(replenishment)/movement` (repl tab) | **Attribute replenishment** `AttributeReplenishmentGrid.tsx` | Sales (30d), Daily demand, Store SOH, WH SOH, Cover | **No** | Sales **sum**; Daily demand **sum**; SOH **sum**; Cover = ΣSOH/Σdemand | ✅ | ❌ | ✅ | ✅ | grid overlay |
| `(replenishment)/movement` | **Replenishment recommendations** `ReplenishmentGrid.tsx` | Score, SOH, Daily demand, Cover, Reorder pt, Target, Recommended | **No** | Score **avg**; SOH **sum**; Daily demand **sum**; Cover = ΣSOH/Σdemand; Reorder pt **sum**; Target **sum**; **Recommended sum ← the single most valuable total on the page** | ✅ | ❌ | ✅ | ✅ | grid overlay |
| `(replenishment)/movement` | **Sale vs Stock Mix** `SaleStockMixGrid.tsx` | Sales, Sale Mix, Store SOH, WH SOH, Stock Mix, Mix Gap | **No** | same as Attribute mix above | ✅ | ❌ | ✅ | ✅ | grid overlay |
| `(stock-details)` | **Stock vs capacity** `StockVsCapacityGrid.tsx` | Base cap., Buffer, Fresh planned, Fresh current, EOSS planned, EOSS current | **No** | all six **sum**; status cols → `—` | ✅ | ❌ | ✅ | ✅ | grid overlay |
| `(workspace)` / `(ho)/sales` | **Store league** `StoreLeagueDrilldown.tsx` | Net, Bills, Units, ATV, UPT, Disc % | **No** | Net **sum**; Bills **sum**; Units **sum**; ATV = Σnet/Σbills; UPT = Σunits/Σbills; Disc % recomputed | ✅ | ❌ | ✅ | ✅ | grid overlay |

> **Caveat on `Bills` in the product-attribute table:** `sales/page.tsx:588` states *"Bills count every bill containing the attribute, so they overlap across groups and do not sum to the network total"*. A `Bills` footer sum would therefore be **wrong**. Render `—` there, or label it explicitly as "overlapping".

### Plain `<table>` tables (no virtualization, no pagination, no sticky header)

| Page | Table name (file:line) | Numeric cols | Has subtotal? | Suggested subtotal per col | Sortable | Empty state |
|---|---|---|---|---|---|---|
| `(ho)/sales` | Top styles — ECOM (`page.tsx:970`) | Units, Net revenue | **No** | Units **sum**, Net **sum** | ❌ | ✅ `:958` |
| `(ho)/sales` | Returns — ECOM (`page.tsx:989`) | Returns (count) | **No** | Returns **sum** | ❌ | ✅ `:977` |
| `(ho)/sales` + `(ho)/network` | Agent-wise sales (`AgentSalesFacetedTable.tsx:73`) | Bills, Units, Net, ATV | **No** | Bills/Units/Net **sum**; ATV = Σnet/Σbills | ❌ (facet-filterable only) | ✅ `:102` |
| `(ho)/sales` + `(ho)/network` | Store diagnosis & opportunity (`StoreDiagnosisFacetedTable.tsx:70`) | Sales Δ, Footfall Δ, Conv, ₹/visitor, Opportunity | **No** | Sales Δ / Footfall Δ **weighted**; Conv = Σbills/Σfootfall; ₹/visitor = Σnet/Σfootfall; **Opportunity sum ← high value** | ❌ | ✅ `:121` |
| `(ebo)/footfall` | Daily footfall log (`page.tsx:140`) | Footfall | **No** | Footfall **sum** (+ a mean/day would suit this screen) | ❌ | ❌ **D-09** |
| `(ho)/targets` | Fresh / Discounted tracker ×2 (`CategoryTracker.tsx:84`) | MTD target, Actual, Cumulative, Ach%, MTD deficit | **No** | MTD target **sum**; Actual **sum**; Cumulative → last-row value; Ach% = Σactual/Σtarget; deficit recomputed | ❌ | ❌ **D-09** |
| `(ho)/targets` | Bulk-upload preview (`bulk-upload-form.tsx`) | target qty cols | **No** | **sum** — a preview table is exactly where a total belongs | ❌ | (upload flow) |
| `(admin)/users` | User admin (`UsersAdmin.tsx:188`) | none (all categorical) | n/a | — | ✅ facet + sort via `FacetFilterBar` | ✅ `:317` |
| `(replenishment)/movement` | Top movers (`movement/page.tsx:244`) | Sales 30D, Velocity, SOH, Cover, Recommended | **No** | Sales **sum**; Velocity **sum**; SOH **sum**; Cover = ΣSOH/Σvelocity; Recommended **sum** | ❌ | prose summary at `:512` only |
| `(stock-details)` | Gender/segment share (`page.tsx:397`) | qty, share % | **No** | qty **sum**; share → `100%` | ❌ | ✅ `:419` |
| `(workspace)` | Weekly per-store (`WeeklyRowDrilldown.tsx:64`) | Net sales, WOW | **No** | Net **sum**; WOW → `—` | ❌ | ✅ `:85` |
| `(workspace)` | Network total weekly (`renderSalesComponents.tsx:284`) | Net sales, WOW | **No** | Net **sum**; WOW → `—` | ❌ | ✅ `:302` |
| `(workspace)` | Agent sales tile (`renderSalesComponents.tsx:360`) | Bills, Units, Net, ATV | **No** | as Agent-wise above | ❌ | ✅ `:382` |
| `(workspace)` | Store diagnosis tile (`renderFootfallComponents.tsx:~190`) | Sales Δ, Footfall Δ, Conv | **No** | as Store diagnosis above | ❌ | — |
| `(workspace)` | Mix tile (`renderMixComponents.tsx`) | sales, mix % | **No** | sales **sum**; mix → `100%` | ❌ | — |
| `(workspace)` | Replenishment tile (`renderReplenishmentComponents.tsx`) | SOH, demand, recommended | **No** | **sum** | ❌ | — |
| `(workspace)` | Stock tile (`renderStockComponents.tsx`) | qty, share % | **No** | qty **sum**; share → `100%` | ❌ | — |

**Cross-cutting table observations:**
- **Sticky header:** only ag-grid tables have one. All 15 plain tables scroll their header away.
- **Horizontal overflow:** handled consistently and correctly — every plain table is wrapped in `overflow-x-auto` with a `min-w-[…]` on the table (e.g. `movement/page.tsx:243` `min-w-[820px]`, `CategoryTracker.tsx:85` `min-w-[560px]`). No page-level horizontal scroll observed.
- **Pagination:** none, anywhere. ag-grid virtualizes; the 15 plain tables render every row into the DOM.
- **Sorting:** ag-grid tables sort on every column. Plain tables have **zero** sortable columns — `FacetFilterBar` gives filtering and group-by but not sort.

---

## Sales → Workspace parity diff

The `(ho)/sales` page gained six features across commits `0432ef8`, `906390c`, `92c9f8b`, `e132999`, `2e83339`. Below, per feature: what Sales has (with file), what Workspace has instead (with file), and what the port needs.

### 1. Period comparison — two date ranges

| | |
|---|---|
| **Sales has** | `ScopeBar` with `showComparison` (`sales/page.tsx:1145`) → renders `components/ui/ComparisonDateRangePicker.tsx` (`ScopeBar.tsx:99`). URL params `compareFrom`/`compareTo`, both-or-neither (`sales/page.tsx:1042–1044`). Comparison queries are issued **only when active** (`:200–222`). Rendering: `DeltaBadge` on 4 shared-core KPIs (`:230–265`) and a 6-card EBO strip (`:429–487`), plus `ComparisonTrendChart` (`:290`). Same-function guarantee: `rollUpCore()` (`:127`) and `computeSalesTotals()` are called once per window — never a parallel formula. |
| **Workspace has** | **Nothing.** `WorkspaceFiltersBar.tsx` exposes only `initialFrom`/`initialTo` (`workspace/page.tsx:281–282`) — a single range. `workspace/page.tsx:71–78` reads one `dateFilter` with `values[0]`/`values[1]`. No comparison param, no `DeltaBadge` import anywhere in `lib/workspace/*`, no `ComparisonTrendChart` import. `SalesKpiGrid` (`renderSalesComponents.tsx:246–258`) renders 6 bare `KpiCard`s with no `delta` prop. |
| **Port needs** | (a) `WorkspaceFiltersBar.tsx` → add the `ComparisonDateRangePicker`; (b) persist `compareFrom`/`compareTo` as a workspace filter row (`lib/workspace/actions.ts`) or a URL param; (c) `SalesComponentScope` (`renderSalesComponents.tsx:68–91`) → add `compareFrom`/`compareTo`; (d) `fetchRaw()` (`:141`) → conditional second window, mirroring `sales/page.tsx:200–222`; (e) `deriveSalesComponentData()` (`:224`) → call `computeSalesTotals` twice; (f) `SalesKpiGrid` → thread `delta={<DeltaBadge …/>}` exactly as `sales/page.tsx:431–486` does, including `mode="pp"` + `invert` on Discount %. |

### 2. Product-attribute breakdown (Season + Year, drag-to-combine)

| | |
|---|---|
| **Sales has** | `ProductAttributeSection` (`sales/page.tsx:546–590`) — its own Suspense boundary and its own **line-grain** fetch via `fetchAllRows` against `sales.vw_ebo_sale_attribute_lines` with the three-key `.order()` required for correct `.range()` pagination (`:557–579`). Renders `app/(ho)/sales/ProductAttributeSalesTable.tsx` (317 lines): drag-and-drop attribute chips, Season+Year default, 8 numeric columns, grouped rows. Aggregation in `lib/sales/attributeBreakdown.ts` (325 lines). |
| **Workspace has** | **Nothing.** No `product_attribute` entry in `SALES_COMPONENT_RENDERERS` (`renderSalesComponents.tsx:393–401` — the seven ids are `sales_kpi_grid`, `weekly_sales_table`, `sales_trend_chart`, `hourly_sales_chart`, `store_league_table`, `scheme_penetration`, `agent_sales_table`). No import of `attributeBreakdown` or `ProductAttributeSalesTable` anywhere under `lib/workspace/`. |
| **Port needs** | (a) New renderer id `product_attribute_table` in `SALES_COMPONENT_RENDERERS`; (b) a row in `workspace.component_definitions` (the page filters the registry by `.in("id", wiredIds)` at `workspace/page.tsx:111`, so an unregistered id renders `def?.name ?? id` with default sizing — the DB row is needed for a proper name/description/cost); (c) the line-grain fetch must be **cost-gated** — it is the only non-pre-aggregated query in the family, so it belongs behind its own `needs…` flag rather than inside the shared `fetchSalesComponentData` `Promise.all` (`workspace/page.tsx:161`); (d) `ProductAttributeSalesTable` is already `"use client"` and takes only serializable `lines` — it can be reused verbatim. |

### 3. Date-grain toggle — Daily / Weekly / Monthly / Yearly

| | |
|---|---|
| **Sales has** | `PeriodSalesFacetedTable` (`PeriodSalesFacetedTable.tsx:56–58, 93, 191–204`) — four pre-computed row-sets switched client-side with **no re-fetch**, built server-side by `buildDailyPeriodSeries` / `buildWeekSeries` / `buildMonthlyPeriodSeries` / `buildYearlyPeriodSeries` (`sales/page.tsx:409–412`). Full remount on grain change via `key={grain}` (`:223`). |
| **Workspace has** | **Weekly only.** `WeeklySalesTable` (`renderSalesComponents.tsx:260–313`) calls `buildWeekSeries` and nothing else. `fetchRaw` fetches only `vw_ebo_sales_weekly` (`:193`) — no daily-full, no monthly. The file header (`:44–52`) documents *why* the weekly fetch can't go through the query planner, but never adds the other three grains. |
| **Port needs** | `fetchRaw` must additionally fetch `vw_ebo_sales_daily` (from `-1 day`) and `vw_ebo_sales_monthly` (from `-400 days`), exactly as `sales/page.tsx:340–356` does, then call all four builders. This is the largest single fetch increase in the port — gate it on the component being present. |

### 4. Per-store blocks + distinct Network total in the period table

| | |
|---|---|
| **Sales has** | Server-side `buildRows()` (`sales/page.tsx:401–408`) flattens to one row per (store, period) and appends a synthetic `storeId: "__network__"` bucket **only when `storesInView.length > 1`**. Client side: default `groupBy: ["store"]` (`PeriodSalesFacetedTable.tsx:97`), `networkGroupLast()` hoists the summary bucket to the bottom (`:45–54`), the banner gets `border-t-2 border-line font-bold` (`:147`), and its data rows get `background: var(--surface-2); fontWeight: 600` (`:231–235`). |
| **Workspace has** | A **different shape**: `WeeklySalesTable` (`renderSalesComponents.tsx:264–311`) renders one **separate bordered `<div>` + `<table>` per store**, each with its own `bg-surface-2` caption bar (`:272–276`), then an extra bordered block for "Network total" (`:281–310`). Per-store blocks are `WeeklyRowDrilldown` (clickable rows); the Network block is a deliberately inert plain `<table>` (`:278–280` explains why). |
| **Assessment** | Workspace's version is arguably *closer* to the user's "store dividers" ask than the Sales version — each store is visually a discrete card. What it lacks is: (a) the four grains; (b) the 11-column set (it shows only Week / Net sales / WOW — no Gross, Discount %, Bills, Qty, ATV, Qty change); (c) faceting/group-by; (d) sorting. |
| **Port needs** | Replace `WeeklySalesTable` wholesale with `PeriodSalesFacetedTable`, **or** widen `WeeklyRowDrilldown`'s column set to match. If replaced, the row-click drilldown (`WeeklyRowDrilldown` → `getStoreDrilldownTrend`) is lost — `PeriodSalesFacetedTable` has no click handler. Decide explicitly which behaviour wins. |

### 5. Faceted filtering / group-by / saved views on the period table

| | |
|---|---|
| **Sales has** | `FacetFilterBar` with `pageKey={`sales_period_${grain}`}` (`PeriodSalesFacetedTable.tsx:206–214`), 12 advanced numeric/text fields (`:103–119`), group-by Store (`:121`), a live "N of M rows" counter (`:215–217`), and per-user saved views. |
| **Workspace has** | **Nothing.** `renderSalesComponents.tsx` imports no `FacetFilterBar`. The workspace-level `WorkspaceFiltersBar` is store+date only. |
| **Port needs** | Comes free with the `PeriodSalesFacetedTable` swap in (4). Use a **distinct `pageKey`** (e.g. `workspace_period_${grain}`) so workspace saved views don't collide with the Sales page's. |

### 6. Section-level error boundaries + independent Suspense streaming

| | |
|---|---|
| **Sales has** | Five `SectionErrorBoundary` + `Suspense` pairs with shape-matched skeletons (`sales/page.tsx:1149, 1170, 1180, 1190, 1200`). A failing section shows a retry button; the rest of the page is unaffected. |
| **Workspace has** | **Zero.** `workspace/page.tsx` imports neither. `LazyMount` (`:196` etc.) defers *mount*, not *fetch* — its own header comment admits data is fetched eagerly. All six family fetches sit in one `await Promise.all` (`:161–175`), so the page blocks on the slowest and any rejection takes down the whole route (with no `error.tsx` to catch it — D-06). |
| **Port needs** | Wrap each `renderedChildren` entry in `SectionErrorBoundary` + `Suspense`, and move each family's fetch inside its own async section component so they stream independently. This is a prerequisite for (2) and (3) — both add expensive queries to a `Promise.all` that already gates the entire page. |

**Port ordering recommendation:** 6 → 3 → 4 → 1 → 5 → 2. Do the streaming/error work first; every other item makes the current single-blocking-`Promise.all` worse.

---

## Progress-bar recommendation

### What exists today — the feature is largely already built

**Two independent mechanisms, both already global:**

1. **`components/ui/TopProgressBar.tsx`** (171 lines) — mounted **once in the root layout**:
   ```tsx
   // app/layout.tsx:29–31
   <body>
     <TopProgressBar />
     {children}
   ```
   A 2.5px fixed bar at `z-[100]`, above the sticky TopNav. It solves the "Next 14 has no public router-events API" problem with four capture-phase listeners plus two custom events (`TopProgressBar.tsx:126–140`):
   - capturing `click` on internal `<a>` (`:104`)
   - capturing `submit` on any `<form>` — covers Server Action forms (`:121`)
   - capturing `change` on `<select>` — covers `StoreFilter`/`DateRangePicker` (`:92`)
   - `window` `"progressbar:start"` / `"progressbar:stop"` CustomEvents (`:96`, `:100`) — used by `MultiSelectFilter`'s popover and by `process-button.tsx`'s preview→commit flow
   - completion on `usePathname`/`useSearchParams` change (`:69–76`), plus a 20s safety timeout (`:89`)
   - a 500ms `SHOW_DELAY_MS` (`:47`) so fast navigations never flash

2. **`components/ui/RouteLoadingBar.tsx`** — the same visual, rendered by each route group's `loading.tsx` (9 of 10 groups), so Next's own Suspense boundary shows a bar during server work.

**Verdict: the user's ask is ~90% already implemented and is genuinely well engineered.** What's missing are three specific gaps.

### Gap 1 — three routes have no `loading.tsx`

`login`, `app/page.tsx` and `sh-test` live directly under `app/`, which has no `loading.tsx`. `(ecomm)` is the only route group missing one.

**Exact fix:** create **`web/app/loading.tsx`**:
```tsx
import { RouteLoadingBar } from "@/components/ui/RouteLoadingBar";
export default function Loading() { return <RouteLoadingBar />; }
```
This is a root-level boundary; it covers `/`, `/login`, `/sh-test` and acts as the fallback for any future route group added without its own. Optionally also add `web/app/(ecomm)/loading.tsx` (identical) for consistency, though that group is a pure redirect.

### Gap 2 — `useTransition` mutations show no bar

Client-side Server Action calls dispatched through `startTransition` never touch a link, form, select, or the URL, so `TopProgressBar` never fires. Affected call sites:

| File | Line | What it does |
|---|---|---|
| `app/(admin)/users/UsersAdmin.tsx` | `:100` | role / status changes |
| `app/(admin)/users/UserDetailDialog.tsx` | `:61` | permission + scope saves |
| `app/(workspace)/workspace/WorkspaceGridClient.tsx` | `:75` | layout save, clear-all |
| `app/(workspace)/workspace/AddComponentPicker.tsx` | `:121` | add component |
| `app/(workspace)/workspace/WorkspaceSwitcher.tsx` | `:37` | create / rename / switch |
| `components/ui/FacetFilterBar.tsx` | `:193` | save / delete view |

Each of these does show *local* `disabled={pending}` state, so nothing is broken — but there's no top-of-page cue.

**Exact fix — one shared hook, `web/components/ui/useProgressTransition.ts`:**
```tsx
"use client";
import { useTransition, useEffect } from "react";

/** useTransition that also drives the global TopProgressBar. */
export function useProgressTransition() {
  const [isPending, startTransition] = useTransition();
  useEffect(() => {
    window.dispatchEvent(new CustomEvent(isPending ? "progressbar:start" : "progressbar:stop"));
  }, [isPending]);
  return [isPending, startTransition] as const;
}
```
Then swap `useTransition()` → `useProgressTransition()` at the six sites above. **No change to `TopProgressBar.tsx` is required** — it already listens for both events (`:96–102`, `:137–138`).

### Gap 3 — `(workspace)/workspace` has no in-page Suspense

Every other data-heavy page streams sections behind skeletons; Workspace blocks on one `Promise.all` (`workspace/page.tsx:161`). The route `loading.tsx` bar covers the navigation, but once the shell renders there is no further cue while six family fetches resolve. Covered by parity item 6 above.

### Summary of exact files to touch

| Action | File |
|---|---|
| **Create** | `web/app/loading.tsx` (4 lines, as above) |
| **Create** (optional) | `web/app/(ecomm)/loading.tsx` (identical) |
| **Create** | `web/components/ui/useProgressTransition.ts` (as above) |
| **Edit** (1-line swap each) | `UsersAdmin.tsx:100`, `UserDetailDialog.tsx:61`, `WorkspaceGridClient.tsx:75`, `AddComponentPicker.tsx:121`, `WorkspaceSwitcher.tsx:37`, `FacetFilterBar.tsx:193` |
| **No change needed** | `app/layout.tsx`, `TopProgressBar.tsx`, `RouteLoadingBar.tsx`, the 9 existing `loading.tsx` files |

**Router-events hook already available:** `TopProgressBar.tsx`'s `usePathname()` + `useSearchParams()` effect (`:69–76`) is the app's completion signal, and the `progressbar:start` / `progressbar:stop` CustomEvent pair is the app's public "I am doing something" API. Both are the right extension points; nothing new needs inventing.

---

## RSC boundary sweep

**Result: no live occurrences found at `014b1c5`.** The class of bug fixed in `507ea4f` does not recur elsewhere in the current tree.

**Method.** Enumerated all **61** `"use client"` files (`grep -rl '"use client"' app components`), extracted every prop-type declaration matching a function signature, `Map<`, `Date`, or `Set<`, then traced each back to its callers.

**Every function-typed prop found is passed client→client, never server→client:**

| Client component | Function prop | Every caller |
|---|---|---|
| `UserDetailDialog.tsx:49,339,363,399,400` | `onOpenChange`, `onClick`, `onChange`, `run`, `onDone` | `UsersAdmin.tsx:333` — itself `"use client"` |
| `FacetFilterBar.tsx:186,545–548` | `onChange`, `onSearchChange`, `onToggle`, `onSetAll`, `onClear` | 6 callers, **all** `"use client"`: `PeriodSalesFacetedTable.tsx:213`, `EcommChannelFacetedTable.tsx:116`, `ProductAttributeSalesTable.tsx`, `UsersAdmin.tsx:174`, `ReplenishmentFacetedContent.tsx`, `SaleStockMixFacetedContent.tsx` |
| `FacetFilterBar.tsx:25,31` | `FacetDef.get`, `AdvField.get` | same six, all client |
| ag-grid `ColDef` callbacks (`cellRenderer`, `valueFormatter`, `valueGetter`, `colSpan`, `cellClass`) | many | all constructed **inside** the client components that own them (`PeriodSalesFacetedTable.tsx:137–182`, `ProductAttributeSalesTable.tsx:160–196`, `ReplenishmentGrid.tsx:113–155`, `SaleStockMixGrid.tsx:54–102`, `AttributeMixGrid.tsx:30–67`, `AttributeReplenishmentGrid.tsx:25–41`, `StockVsCapacityGrid.tsx:38–48`, `StoreLeagueDrilldown.tsx:70–113`, `EcommChannelFacetedTable.tsx:91`) — never crossing a boundary |
| `SectionErrorBoundary.tsx:20` `onRetry` | function | supplied **inside** the wrapper (`:61`), which is itself `"use client"`. Server callers pass only `label: string` + `children`. ✅ correct pattern. |

**Non-serializable value types — checked and clean:**

| Value | Where it lives | Verdict |
|---|---|---|
| `storeNames: Map<string,string>` | `sales/page.tsx:1116` | Passed only to **server** components (`EboDetailSection` `:1178`, `FootfallDiagnosisSection` `:1198`) and to `computeFootfallInsights` (a plain function). Where it must reach a client component it is converted: `AgentSalesFacetedTable storeNames={Object.fromEntries(storeNames)}` (`sales/page.tsx:513`). ✅ |
| `storeNames` | `workspace/page.tsx:67` | Passed to `fetchSalesComponentData` / `fetchFootfallComponentData` — server-side only. The derived `SalesComponentData.storeNames` is consumed by `AgentSalesTable` / `WeeklySalesTable`, both of which are **server** components in `renderSalesComponents.tsx`. ✅ |
| `today: Date` | `sales/page.tsx:1179, 1198` | Passed to server components only. ✅ |
| `supabase` client instance | `sales/page.tsx:1152` etc. | Passed to server components only. ✅ |
| `t: Dict` | `footfall/page.tsx:127` → `FootfallCounter` (client) | `Dict` is a plain `Record<string,string>` from `lib/i18n/translations.ts` — serializable. ✅ |
| `channelHref` | previously `sales/page.tsx` → `EcommChannelFacetedTable` | **Fixed in `507ea4f`** — now built client-side from `usePathname`/`useSearchParams` (`EcommChannelFacetedTable.tsx:56–65`). The remaining `channelHref` in `sales/page.tsx:1069` is passed only to `EcommDetailSection`, an **async server** component (`:820`), and used there for a `<Link href>` (`:930`). ✅ |
| `SALES_COMPONENT_RENDERERS[…]` component refs | `workspace/page.tsx:194–238` | Server components rendered by a server component. React elements, not props. ✅ |

**One item worth watching (not a bug today):** `workspace/page.tsx:97` builds `ALL_RENDERERS: Record<string, unknown>` and each family's `Renderer` is invoked as `<Renderer data={…} />`. Every renderer in the six `*_COMPONENT_RENDERERS` maps is currently a **server** component. If anyone adds a `"use client"` renderer whose data contains a `Map` (e.g. `SalesComponentData.storeNames`, `renderSalesComponents.tsx:236`), it will throw the same "Maps are not supported" RSC serialization error. Worth a comment on the type, or converting `storeNames` to a plain object in `deriveSalesComponentData`.

---

## Number formatting audit

### Currency

Consistent by content, duplicated by construction. The canonical form is `₹` + `Math.round(n)` + `toLocaleString("en-IN")` (Indian grouping: `₹12,34,567`), replicated verbatim in 16 files — see **D-12**.

**One divergence:** `components/ui/FootfallMatrixCells.tsx:23`
```tsx
const INR_SHORT = (n: number) => (n >= 100000 ? `₹${(n / 100000).toFixed(2)}L` : `₹${Math.round(n).toLocaleString("en-IN")}`);
```
Lakh notation used nowhere else. It renders on `(ho)/sales` directly above `StoreDiagnosisFacetedTable`, which uses full notation for the same quantity.

### Decimals

Consistent conventions, applied uniformly:
- Percentages → `.toFixed(1)` (`PeriodSalesFacetedTable.tsx:172`, `EcommChannelFacetedTable.tsx:18`, `renderSalesComponents.tsx:251`)
- UPT → `.toFixed(2)` (`sales/page.tsx:468`, `ProductAttributeSalesTable.tsx:195`, `StoreLeagueDrilldown.tsx:104`)
- Cover days → `.toFixed(1)` + `"d"` suffix (`AttributeReplenishmentGrid.tsx:41`)
- Penetration/completeness → `.toFixed(0)` (`renderFootfallComponents.tsx:89, 101`)
- Currency → `Math.round()`, no decimals

### Rounding before aggregation

**None found — this is done correctly throughout.** Every `Math.round()` / `.toFixed()` sits in a `valueFormatter`, a template literal, or a JSX expression — i.e. at the display edge, after all summation. Grep across `lib/` returned no case of a rounded value being fed back into an accumulator.

Two borderline cases, both benign:
- `lib/exports/scheduledExports.ts:130,135,138` — `Number(r.score.toFixed(1))` etc. This rounds for **CSV output**, terminal, not re-aggregated.
- `lib/exports/scheduledExports.ts:218` — `Number(((bills / r.footfall!) * 100).toFixed(1))`, same.

### Negative numbers — the returns question

**Verdict: `-1,234` (native minus sign). Never parenthesised, never silently absolute.**

`toLocaleString("en-IN")` on a negative renders `-12,34,567`, and no formatter strips the sign. Two places actively *rely* on the sign being preserved:
- `PeriodSalesFacetedTable.tsx:61–70` `ChangeCell` — branches on `value >= 0`, prepends `"+"` for positives, and pairs the sign with a `TrendingUp`/`TrendingDown` glyph plus `text-good`/`text-crit`. Colour is **not** the only channel; the glyph carries it too (good a11y practice).
- `AttributeMixGrid.tsx:56` / `SaleStockMixGrid.tsx:88` — `cellClass` branches on `p.value > 0 ? "text-good" : p.value < 0 ? "text-crit" : "text-ink-3"` for the Mix Gap column.

The only `Math.abs()` in a display path is `lib/network/footfall.ts:288`, where it's grammatically correct (`"down 12.3% week-over-week"` — the direction is in the word "down").

**The one place sign-preservation is the wrong behaviour:** the `Returns` column at `ProductAttributeSalesTable.tsx:196` renders `INR(p.value)` unmodified, and `lib/sales/attributeBreakdown.ts:295` accumulates the now-signed (negative) `net_amount`. So a column headed "Returns" shows a negative rupee figure, where a larger return volume reads as a smaller number. See **D-21** for the full account, including the stale header comment in that file.

### Null / undefined rendering

**No `NaN` or `undefined` leak found.** The house convention is the em-dash `—`, applied consistently:
- `PeriodSalesFacetedTable.tsx:172` `p.value === null ? "—" : …`
- `PeriodSalesFacetedTable.tsx:184` ATV
- `EcommChannelFacetedTable.tsx:18` `PCT`
- `ProductAttributeSalesTable.tsx:194–196`
- `sales/page.tsx:249, 263, 460, 467` KPI cards
- `AttributeReplenishmentGrid.tsx:41` Cover
- `StoreLeagueDrilldown.tsx:95, 104, 113`
- `renderSalesComponents.tsx:251–255, 298`
- `my-store/page.tsx:38` `week ? … : "—"` with `tone="muted"`

Division guards are present everywhere: `w.gross > 0 ? … : null` (`sales/page.tsx:391`), `c.orders > 0 ? … : null` (`:911`), `bills > 0 ? … : "—"` (`renderSalesComponents.tsx:379`), `target > 0 ? … : 0` (`CategoryTracker.tsx:98`).

**One exception — D-13:** `CategoryTracker.tsx:105–107` prints raw integers with no locale formatting.

### Dates

`toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })` on upload/audit timestamps (`data-upload/page.tsx:62`, `targets/page.tsx:304`, `renderTargetsComponents.tsx:115`) — correct and explicit. But two client components use a **bare** `toLocaleString()` with no locale or timezone:
- `app/(ho)/network/AlertSubscriptionToggle.tsx:39` — `last sent ${new Date(...).toLocaleString()}`
- `app/(workspace)/workspace/ScheduledExportsPanel.tsx:71` — `Last run ${new Date(...).toLocaleString()}`

These render in the browser's locale/timezone, so two users see different strings, and (being client-rendered from a server-provided ISO string) they are hydration-mismatch candidates. Minor, but inconsistent with the rest.

Raw ISO dates are shown unformatted in several scope labels — `sales/page.tsx:1128` (`${from} to ${to}`), `:434`, `:709`, `workspace/page.tsx:268`. Deliberate and unambiguous, but stylistically at odds with `weekDayLabel` (`sales/page.tsx:517`), which formats as `27 Aug`.

---

## Typecheck output

**Command:** `node ./node_modules/typescript/bin/tsc --noEmit` (run from `web/`; the npm script is broken — see D-19)

**Output:**
```
(no output)
EXIT: 0
```

**Clean.** Zero type errors across 31,415 lines in 178 `.ts`/`.tsx` files. Notably `tsconfig.json` compiles with no suppressions in play — see the TODO/`any` inventory below.

## Lint output

**Command:** `node ./node_modules/next/dist/bin/next lint` (run from `web/`)

**Output:**
```
? How would you like to configure ESLint? https://nextjs.org/docs/basic-features/eslint
❯  Strict (recommended)
   Base
   Cancel   ⚠ If you set up ESLint yourself, we recommend adding the Next.js
             ESLint plugin. See https://nextjs.org/docs/basic-features/eslint#migrating-existing-config
```

**Lint has never run on this codebase.** ESLint is not configured, not installed as a devDependency, and `next lint` falls into its interactive first-run wizard instead of checking anything. See **D-02**.

---

## TODO / FIXME / console / `any` inventory

### `TODO` / `FIXME` / `HACK` / `XXX`

```
grep -rn "TODO|FIXME|HACK|XXX" app components lib --include=*.ts --include=*.tsx
→ 0 results
```
**Zero.** Genuinely unusual and worth noting as a positive.

### `any` casts

```
grep -rn "as any|: any\b|<any>" app components lib
→ 5 results, ALL of them prose inside comments:
   components/ui/input.tsx:15                  "…a shared component was overdue: any…"
   lib/erpReports/parseSchemeWorkbook.ts:43    "…is 'has any non-blank scheme at all'…"
   lib/replenishment/compute.ts:44             "…whether this item_code has any current stock…"
   lib/replenishment/mix.ts:36                 "…whether this item_code has any current stock…"
   lib/supabase/admin.ts:8                     "…doesn't act as any particular signed-in user…"
```
**Zero real `any` casts.**

### `@ts-ignore` / `@ts-expect-error`

```
→ 0 results
```

### `as unknown as` (the escape hatch actually in use)

| File | Count |
|---|---|
| `app/(ho)/sales/page.tsx` | **22** |
| `lib/workspace/renderFootfallComponents.tsx` | 6 |
| `lib/workspace/renderSalesComponents.tsx` | 5 |
| `app/(ho)/sales/PeriodSalesFacetedTable.tsx` | 1 |
| `app/(ho)/sales/ProductAttributeSalesTable.tsx` | 1 |
| `app/(replenishment)/replenishment/ReplenishmentGrid.tsx` | 1 |
| `app/(replenishment)/sale-stock-mix/SaleStockMixGrid.tsx` | 1 |
| `app/(ebo)/footfall/footfall-counter.tsx` | 1 |
| `lib/data/client.ts`, `lib/data/admin.ts` | 1 each |
| **Total** | **40** |

Two distinct populations:
- **~36 of them** are `applyStore(…) as unknown as QueryChain<T>` — a structural mismatch between the PostgREST builder's declared return type and the app's `QueryChain<T>` abstraction (`lib/data/client.ts`). Not dangerous, but it's a repeated double-cast that defeats the type system exactly where the row shapes matter. Worth fixing once by widening `QueryChain`'s definition or giving `applyStore` a proper generic signature.
- **~4** are `p.data as PeriodFacetedRow` / `as GridRow` narrowings in ag-grid renderers, guarded by an `isGroupHeader()` type predicate immediately above. Safe.

### `console.*` left in

19 total. All are deliberate server-side operational logging — **no stray debug `console.log` in any client component.**

| File:line | Level | Assessment |
|---|---|---|
| `lib/perf/timing.ts:18, 34` | `log` | Perf instrumentation, server-side, always-on. The only unconditional `console.log` in the app; consider gating on `NODE_ENV !== "production"`. |
| `app/(admin)/users/actions.ts:92, 226, 228, 388` | `warn` | Permit/audit sync failures — non-fatal by design. ✅ |
| `app/api/sales-source/sale-detail/route.ts:45, 52, 112` | `error` | API diagnostics. ✅ |
| `components/ui/SectionErrorBoundary.tsx:32` | `error` | **The one client-side call.** Correct — it's how a caught boundary error is surfaced. ✅ |
| `lib/auth/roles.ts:365, 371` | `warn` | Documents a **fail-OPEN** on Permit check failure (`"failing OPEN"`). Frontend-visible consequence only; the security posture is Agent B/C territory. |
| `lib/erpReports/retention.ts:42, 58, 63` | `error` | ✅ |
| `lib/keycloak/middleware.ts:72, 77` | `error` | ✅ |
| `lib/salesSource/client.ts:97, 132` | `error` | ✅ |

### `dangerouslySetInnerHTML`

**One occurrence, and it is correct:**
```tsx
// app/layout.tsx:27
<script dangerouslySetInnerHTML={{ __html: NO_FLASH_THEME }} />
```
`NO_FLASH_THEME` is a module-level string constant (`:14–21`), no interpolation, no user input. This is the standard no-FOUC theme pattern and must be inline+synchronous to work.

### Hardcoded IDs / URLs

- `"BO-004"` / `"BO-002"` store exclusions in 9 files — **D-18**.
- `"192.168.1.233"` at `logic-erp-form.tsx:71` — a `placeholder` attribute only, not a default value. Acceptable, though it does leak an internal LAN address into the client bundle.
- `PAGE_KEY` string literals per faceted table (`"sales_period"`, etc.) — intentional, they key saved views.
- No hardcoded API base URLs; everything uses relative `/api/…` paths.

### Dead / unreachable code

- `components/ui/RowsPerPageSelect.tsx` — never imported (**D-15**).
- `react-hook-form` dependency — never imported (**D-16**).
- `app/sh-test/*` — self-described "not a real page… Delete once real pages have been migrated"; excluded from middleware (`middleware.ts:26`).
- `AppShell.tsx:56` `NAV_GROUP_ORDER` includes `"Sales"` and `"Marketing"`, but no `NAV_LINKS` entry uses either group. The `.filter((g) => g.links.length > 0)` at `:154` makes this harmless, and the comment acknowledges it.

### Duplicated logic

Beyond `INR`/`fmt`/`PCT` (**D-12**):
- **Store-filter closure** — `applyStore` is re-implemented in `sales/page.tsx:1051–1055` and `renderSalesComponents.tsx:143–147` with identical eq/in branching.
- **`isoDate`** — `(d: Date) => d.toISOString().slice(0,10)` defined in `sales/page.tsx:117`, `workspace/page.tsx:39`, `footfall/page.tsx:15`, `DateRangePicker.tsx:8`, `ComparisonDateRangePicker.tsx:18`.
- **Click-outside popover effect** — near-identical in `AddComponentPicker.tsx:124`, `WorkspaceFiltersBar.tsx:87`, `WorkspaceSwitcher.tsx:40`, `FacetFilterBar.tsx:200`, `StoreFilter.tsx:212`, `DateRangePicker.tsx:44`. Six copies; a `useClickOutside(ref, onOutside)` hook would collapse them.
- **Group-header `colSpan` renderer** — structurally identical in `PeriodSalesFacetedTable.tsx:138`, `ProductAttributeSalesTable.tsx:164`, `ReplenishmentGrid.tsx:114`, `SaleStockMixGrid.tsx:56`, each with its own hand-maintained column-count literal (`11`, `colCount`, `14`, `9`).

### Unhandled promise rejections / missing `await`

- `components/ui/FacetFilterBar.tsx:197` — **D-10**, the one genuine case.
- All other async paths are `await`ed inside `try/catch` or inside `startTransition` with an explicit error state. No floating promises found elsewhere.

### `useEffect` audit

17 `useEffect` calls reviewed individually. **All event-listener and observer effects have correct cleanup:**

| File:line | Cleanup | Notes |
|---|---|---|
| `footfall-counter.tsx:88` | ✅ `clearTimeout` | Explicit "don't lose the last taps" comment |
| `ReplenishmentGrid.tsx:88` | n/a (imperative grid API) | ✅ deps `[preserveOrder]` correct |
| `AddComponentPicker.tsx:124` | ✅ removes `mousedown` + `keydown` | |
| `LazyMount.tsx:26` | ✅ IntersectionObserver disconnect | |
| `WorkspaceFiltersBar.tsx:87` | ✅ | has an `eslint-disable exhaustive-deps` at `:102` for `closeAndCommit` — a stale-closure risk on `pending`, but `pending` is in the deps so it's actually fine |
| `WorkspaceFiltersBar.tsx:106` | n/a (focus only) | |
| `WorkspaceGridClient.tsx:80` | n/a (state reset on `[items]`) | |
| `WorkspaceGridClient.tsx:85` | ✅ `observer.disconnect()` | |
| `WorkspaceSwitcher.tsx:40` | ✅ | |
| `ComparisonDateRangePicker.tsx:57`, `DateRangePicker.tsx:44` | ✅ | |
| `FacetFilterBar.tsx:196` | ❌ **D-10** | no catch, no guard |
| `FacetFilterBar.tsx:200` | ✅ | |
| `StoreFilter.tsx:212` | ✅ | |
| `ThemeToggle.tsx:12` | n/a (one-shot read) | |
| `TopProgressBar.tsx:69` | ✅ `stop()` clears both timers | `mounted` ref correctly skips the first run |
| `TopProgressBar.tsx:78` | ✅ removes all 5 listeners + `stop()` | |

**No refetch loops found.** No effect calls a fetch with an unstable object/array dependency.

---

## Accessibility & responsive findings

### Accessibility — better than typical

**Strengths, verified:**
- **23 `aria-label`s**, and they are on the right elements — icon-only buttons (`ThemeToggle.tsx:36`, `rename-user-button.tsx:29`, `WorkspaceGridClient.tsx:190`, `WorkspaceSwitcher.tsx:119`), remove-chips (`ProductAttributeSalesTable.tsx:263`, `WorkspaceFiltersBar.tsx:172`, `alert-mailer-form.tsx:200`), and bare `<select>`s (`LanguageSwitcher.tsx:24`, `StoreFilter.tsx:58,112,255`).
- **All three chart components are `role="img"` with a descriptive label** — `TrendChart.tsx:23`, `HourlyBarChart.tsx:38`, `ComparisonTrendChart.tsx:69`. Callers supply real sentences, e.g. `sales/page.tsx:295`: *"Daily net sales across the selected verticals, current period against the comparison period"*.
- **`role="listbox"` + `aria-multiselectable`** on the store picker (`WorkspaceFiltersBar.tsx:239`).
- **Touch targets:** `ThemeToggle.tsx:34` uses `min-h-[40px] min-w-[40px]` with an explicit comment about a 7px glyph being untappable. `min-h-[36px]` appears on filter controls (`LanguageSwitcher.tsx:23`, `footfall/page.tsx:102`).
- **Colour is never the sole channel:** `ChangeCell` (`PeriodSalesFacetedTable.tsx:61–70`) pairs `text-good`/`text-crit` with a `TrendingUp`/`TrendingDown` glyph **and** a `+`/`−` sign.
- **No `<img>` tags at all** in the app — so no missing `alt`. Brand mark is a styled `<span>` (`AppShell.tsx:213`); all icons are `lucide-react` SVGs inside labelled buttons.
- Native `required` + `type="email"` on the login form (`login/page.tsx:34, 42`), with a considered `autoFocus` heuristic (`:37, :42`).

**Gaps found:**

| Issue | Where | Impact |
|---|---|---|
| **Mobile nav link has no `aria-current`** | `AppShell.tsx:190` | Desktop is correct — `SidebarNav.tsx:71` does set `aria-current={active ? "page" : undefined}`. Only the `md:hidden` mobile row omits it, so mobile screen-reader users can't tell which page they're on |
| **Mobile nav uses `<a>` not `<Link>`** | `AppShell.tsx:189` | Full document reload on every mobile navigation; also defeats `TopProgressBar`'s SPA completion signal |
| **Deficit heat-map cell is colour-only** | `CategoryTracker.tsx:117` `style={{ backgroundColor: deficitHeat(deficitPct) }}` | The number is present, so not disqualifying, but the heat scale itself is inaccessible |
| **Matrix quadrants convey state by colour + position** | `FootfallMatrixCells.tsx`, `sales/page.tsx:774–786` | Quadrant headers are text (`"Conversion up"` etc.), so recoverable — but store chips inside carry no per-store status text |
| **No skip-to-content link** | `AppShell.tsx` | Keyboard users tab through 10 nav links on every page |
| **Popovers are not focus-trapped** | `StoreFilter.tsx:212`, `WorkspaceFiltersBar.tsx:87`, `AddComponentPicker.tsx:124`, `FacetFilterBar.tsx:200` | Tab escapes the open dropdown into the page behind. `Escape` closes correctly in most (`AddComponentPicker.tsx:129`, `WorkspaceFiltersBar.tsx:93`, `StoreFilter.tsx:217`) but **not** in `WorkspaceSwitcher.tsx:40` or `DateRangePicker.tsx:44`, which register only `mousedown` |
| **`suppressCellFocus` on every grid** | `DataGrid.tsx:43` | Disables ag-grid's built-in keyboard cell navigation across all 9 tables |
| **Drag-and-drop has a keyboard fallback — verify it's discoverable** | `ProductAttributeSalesTable.tsx:216` `onClick={() => addToCombo(attr)}` with `title="Drag into the box, or click to add"` | ✅ Good: click works as a drag alternative. But removal is only via the `aria-label`'d ✕ (`:263`) — reordering within the combo appears drag-only |
| **Dark-mode contrast inside grids** | `DataGrid.tsx:23–37` — **D-03** | Not a contrast *ratio* problem so much as a total theme failure |

### Responsive

**Handled well:**
- KPI grids ladder properly: `grid-cols-2 sm:grid-cols-3 lg:grid-cols-5` (`sales/page.tsx:229`), `lg:grid-cols-6` (`:437`), `sm:grid-cols-3 lg:grid-cols-4` (`Skeleton.tsx:80`).
- Two-column sections collapse: `grid-cols-1 gap-6 lg:grid-cols-2` (`sales/page.tsx:501`).
- **Every wide table is wrapped in `overflow-x-auto` with a `min-w-[…]` on the inner table** — `movement/page.tsx:243` (`min-w-[820px]`), `CategoryTracker.tsx:85` (`min-w-[560px]`), `stock-details/page.tsx:397` (`min-w-[420px]`), and the two matrices at `sales/page.tsx:769` / `:801` (`min-w-[560px]`). `targets/page.tsx:231` even comments on why two 560px tables can't sit side by side on narrow screens. **No page-level horizontal scroll** results from any of these.
- Content is capped at `max-w-[1280px]` with `px-8` (`AppShell.tsx:200`).
- Header rows use `flex-wrap` (`footfall/page.tsx:88`, `workspace/page.tsx:260`).

**Problems:**

| Issue | Where | Impact |
|---|---|---|
| **Mobile nav overlaps page content** | `AppShell.tsx:187` is `fixed top-14` and wraps to 2–3 rows with 10 links; content padding is a fixed `pt-14` (`:199`) which accounts only for the top bar | On a phone, the top of every page renders **underneath** the nav. This is the most visible responsive defect. |
| **No mobile drawer** | `AppShell.tsx:173` sidebar is `hidden md:flex` | **D-17** |
| **`react-grid-layout` is width-driven, not breakpoint-driven** | `WorkspaceGridClient.tsx:85–94` uses a `ResizeObserver` and passes raw `width` | A 12-column workspace layout on a 375px viewport gives ~31px columns. `ReactGridLayout` (not `Responsive`) is used, so there are no breakpoint layouts. Workspace is effectively desktop-only. |
| **`px-8` on mobile** | `AppShell.tsx:200` | 64px of horizontal padding on a 375px screen leaves 311px of content. Should step down to `px-4 md:px-8`. |
| **Fixed-width grid template columns** | `sales/page.tsx:622` `grid-cols-[140px_1fr_auto]` (scheme bars), `:770` `grid-cols-[90px_1fr_1fr]` (matrix) | The matrix is inside `overflow-x-auto` ✅; the scheme-penetration bars at `:622` are **not**, so a long scheme name + a wide `₹…` suffix can squeeze the bar to nothing on narrow screens |
| **`max-w-xs` right-aligned helper text** | `workspace/page.tsx:271` | Fine on desktop; on mobile it right-aligns a paragraph directly under a left-aligned heading |

---

## VERIFIED CORRECT

Things explicitly checked that are right, and worth not breaking:

1. **Typecheck is clean** — `tsc --noEmit` exit 0, zero errors, 31,415 lines.
2. **Zero `any`, zero `@ts-ignore`, zero `@ts-expect-error`, zero TODO/FIXME/HACK/XXX.**
3. **The `507ea4f` RSC bug does not recur** — full sweep of 61 client components found no server→client function, `Map`, `Set`, `Date`, or class-instance prop. `Object.fromEntries(storeNames)` at `sales/page.tsx:513` shows the correct pattern being applied deliberately.
4. **`SectionErrorBoundary` is architecturally correct** — `onRetry` is constructed inside the client wrapper (`:61`), never crossed from a server caller. Retry uses `router.refresh()` (re-runs the RSC) rather than resetting local state, which the header comment correctly identifies as the only thing that actually re-runs the query.
5. **`(ho)/sales` streaming architecture** — 5 independent `SectionErrorBoundary` + `Suspense` pairs, each with a shape-matched skeleton rather than a spinner. One section failing or being slow doesn't affect the others.
6. **`TopProgressBar` is a genuinely good solution** to Next 14's missing router-events API — capture-phase listeners for link/form/select, a CustomEvent escape hatch for popover and multi-step flows, a 500ms delay so fast navigations never flash, a 20s safety net, and `usePathname`/`useSearchParams` as the real completion signal. Full listener cleanup. Wrapped in `Suspense` (`:165`) so `useSearchParams` doesn't de-opt the whole app to CSR.
7. **`fetchAllRows` pagination on the line-grain query** (`sales/page.tsx:557`) with a **three-key `.order()`** (`:576–578`) — correctly guards both the PostgREST 1000-row cap *and* the non-deterministic-ordering bug that makes `.range()` pagination silently drop rows. Matches memory `project_postgrest_max_rows_cap.md`.
8. **Upload flow** (`data-upload/upload-form.tsx`) is the strongest state handling in the app: 5-state discriminated union, XHR for real upload progress (fetch has none), direct-to-Storage signed URL to bypass Vercel's 4.5MB body ceiling, per-percent progress bar, distinct error and done states, `disabled={busy}` on both the file input and the submit button, and `fileRef.current.value = ""` reset on success. The header comment documents the exact production failure that motivated each choice.
9. **Double-submit protection is present on every mutating control** — either `useTransition`'s `pending` (`UsersAdmin.tsx:226,248`, `UserDetailDialog.tsx:263,428,458,469`) or an explicit `saving`/`busy` flag (`business-unit-button.tsx:93,103,111`, `page-access-button.tsx:127,146,154`, `rename-user-button.tsx:72,79,87`, `store-access-button.tsx:89,99,107`, `alert-mailer-form.tsx:123,197,221,232,247,265,281`). No form found without it.
10. **`useEffect` hygiene** — 17 effects, every listener/observer/timer cleaned up, no refetch loops, no unstable-dependency churn (D-10 excepted).
11. **Null/division safety** — every ratio is guarded (`> 0 ? … : null`) and every nullable renders `—`. No `NaN` or `undefined` reaches the DOM.
12. **Rounding happens at display only.** No case anywhere of `.toFixed()`/`Math.round()` feeding an accumulator.
13. **Negative numbers render with a real minus sign**, reinforced by direction glyphs, never parenthesised or absolute'd.
14. **Horizontal overflow is handled correctly on every wide table** — `overflow-x-auto` + `min-w-[…]`, so no page-level horizontal scroll.
15. **No `<img>` anywhere** → no missing `alt` text.
16. **Charts are `role="img"` with meaningful labels** on all three chart components.
17. **`dangerouslySetInnerHTML`** — one use, a static constant, the correct no-FOUC pattern.
18. **Auth gating is layered and consistent** — route-group `layout.tsx` does a coarse `requireRole`/`requirePageAccess`, and each page re-checks its own page key (the comments at `stock-details/layout.tsx:8` and `workspace/page.tsx:46` explain the React-`cache()` memoization that makes this cheap). Feature-level gates exist too (`data-upload/page.tsx:89`, `movement/page.tsx:572–573`).
19. **`(replenishment)/movement` has the best no-permission UX in the app** — two independently grantable tabs, a denied tab falls back to the other rather than rendering blank (`:576`), a tab you can't see isn't offered as a link (`:592`, `:603`), and there's an explicit both-denied message (`:586`).
20. **`(stock-details)` has the best first-use empty state** — `:212` explains that no stock snapshot is loaded *and* links to the Data Upload page to fix it.
21. **`grain` change forces a full ag-grid remount** via `key={grain}` (`PeriodSalesFacetedTable.tsx:223`) — correct, since the row identity axis changes entirely.
22. **`getRowId` is supplied on every ag-grid table**, so row identity survives re-renders.
23. **`footfall-counter.tsx` `key={storeId}`** (`footfall/page.tsx:126`) with an explicit "load-bearing" comment — prevents the counter carrying one store's count into another. Correct.
24. **Redirect stubs preserve query state** — `/network` and `/ecomm` rebuild `from`/`to`/`store`/`channel` into the `/sales` URL (`network/page.tsx:23–29`, `ecomm/page.tsx:23–28`), and `/ecomm` forces `bu=ecomm` so a bookmark doesn't silently widen scope.
25. **Comparison numbers always come from the same function as current numbers** — `rollUpCore()` and `computeSalesTotals()` are each called twice with different windows, never re-implemented (`sales/page.tsx:127`, `:224`, `:377`). This is the discipline that prevents "two things on one screen disagree".

---

## UNVERIFIED

Items I could not prove from static reading. Each states the exact check needed.

| # | Claim | Exact check needed |
|---|---|---|
| U-1 | ~~Sign of the `Returns` column~~ | **Resolved — promoted to finding D-21.** |
| U-2 | Whether any ag-grid table actually degrades at real data volume. | Load `/movement?tab=replenishment` against production-scale data (the header at `ReplenishmentGrid.tsx:67` says server-side pagination was *removed*, so the full row set is now client-side). Measure DOM node count and time-to-interactive. ag-grid virtualizes rows but not the client-side filter pass in `applyFacetFilter`. |
| U-3 | Whether the mobile nav actually overlaps content (D-17). | Static reading says yes (`fixed top-14` wrapping nav + fixed `pt-14` content). Confirm by loading any page at 375×812 and checking whether the `<h1>` is occluded. |
| U-4 | Whether ag-grid tables are genuinely unreadable in dark mode (D-03). | Toggle the theme on `/sales` and screenshot the period table. Static evidence (pinned light hex + no `--ag-` overrides in `globals.css`) makes this near-certain, but visual confirmation would fix the severity. |
| U-5 | Whether `workspace.component_definitions` actually contains rows for all 7 wired sales renderer ids. | `select id, name, cost from workspace.component_definitions;`. `workspace/page.tsx:111` filters `.in("id", wiredIds)`, and `:141–148` falls back to `def?.name ?? id` — so a missing row degrades silently to a raw id as the card title. |
| U-6 | Whether `lib/auth/roles.ts:371`'s **fail-OPEN** on a Permit check failure is intended. | The comment reads `[permit] check failed, failing OPEN`. Confirm with whoever owns the RBAC design. Out of this audit's scope (Agent B/C) but it has a direct frontend consequence: a Permit outage makes every page visible to every role. |
| U-7 | Whether the two bare `toLocaleString()` calls cause hydration warnings. | Load `/workspace` (with a scheduled export that has run) and `/sales` with an alert subscription, and check the console for a hydration mismatch. `ScheduledExportsPanel.tsx:71` and `AlertSubscriptionToggle.tsx:39` format a server-provided ISO string in the browser's locale. |
| U-8 | Whether the `overlayNoRowsTemplate` strings actually render. | ag-grid shows the no-rows overlay only when `rowData` is `[]`, not `null`. Several call sites pass a `useMemo`'d array that is always defined, so this should work — but `DataGrid` also sets `heightPx` from `filtered.length` (e.g. `EcommChannelFacetedTable.tsx:137` → `Math.max(160, …)`), so an empty grid is 160px. Confirm the overlay is visible in that space. |
| U-9 | Large-file upload behaviour end-to-end. | `upload-form.tsx` advertises "up to 50MB" (`:112`) and streams direct to Storage, bypassing Vercel's body limit. But `api/data-upload/process/[id]/commit/route.ts` (291 lines) still parses the workbook server-side. Upload a real 50MB master file and confirm the commit route doesn't hit the function memory or duration ceiling. |
| U-10 | Whether `sh-test` is reachable in production. | `middleware.ts:26` excludes `sh-test` from the session check. Its own page gates on `getValidAccessToken()` (`sh-test/page.tsx:14,18`), so unauthenticated visitors see only the login form — but the route is publicly addressable and dumps raw session claims once authenticated. Confirm whether it's deployed, and delete it if the Keycloak migration is done (its header says to). |

---

*End of Audit D.*
