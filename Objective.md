# Objective — Retail Intelligence Workspace

Reference document for this evolution of the Stock & Sales BI app. Read this
before making architectural decisions. Update it when the objective itself
changes — not on every code change (that's what git history and HANDOFF.md
are for).

## Core objective

Evolve the existing Stock & Sales BI application into a governed,
configurable **Retail Intelligence Workspace** — where users assemble their
own view of the business from approved retail metrics, dimensions and
components, while the system intelligently fetches only the data a given
workspace actually needs.

Full architectural detail lives in the Phase 0 audit artifact
("Retail Intelligence Workspace Blueprint"). This file is the short,
durable summary — the blueprint is the long one.

## Non-negotiable rule

**Do not change, break, reinterpret, simplify or remove any existing
business logic, KPI definitions, calculations, workflows, permissions, RLS
rules, data relationships or user journeys unless explicitly approved.**

Every KPI formula this project touches must trace to a cited source
(SQL file:line or TS file:line) and, where practical, a parity check against
production behavior. See `web/lib/workspace/semantic.ts` and
`web/scripts/parity-check.mjs` for the mechanism.

## Scale target — added 2026-08-15

**Design and build as if this deploys to 100+ stores and multiple
warehouses running concurrently — not the 2-store local dev dataset.**
This is a standing constraint on every decision from here forward, not a
one-time pass. Concretely:

- **No UI pattern that lists "all stores" as flat checkboxes/rows without
  search or virtualization.** A picker fine for 2 stores becomes unusable
  at 100 — every store-facing selector must scale (search-to-filter at
  minimum; virtualized lists if the option count is genuinely unbounded).
- **No page pattern that renders "one block/table per store" without
  pagination, grouping, or a rollup-first view.** Several existing pages
  (Network's per-store week tables, Stock Details' per-store comparison
  tables) render one card per store in the current view — correct at 2
  stores, a wall of cards at 100. These need a summary-first / drill-down
  pattern before they can be trusted at real scale, even though they are
  functionally correct today.
- **Row-volume queries need real scrutiny, not just correctness.**
  `lib/replenishment/compute.ts` and `mix.ts` already pull up to
  40,000 stock rows and 100,000 sale rows network-wide (flagged high-cost
  in the Phase 0 audit and the component registry). At 100+ stores those
  caps will be hit and silently truncate data — this is no longer a
  hypothetical performance concern, it is a correctness deadline. Whoever
  picks up Phase 1c's deferred SQL-side aggregation work should treat this
  as the forcing function.
- **Warehouses are not "a store with a different label."** The
  allocation engine already treats warehouse branches as whatever isn't a
  known store (no hardcoded name), which was the right call — but nothing
  in the current schema models *multiple* warehouses as first-class
  entities with their own identity, capacity, or transfer rules. If the
  real deployment has "many warehouses," this needs an explicit design
  pass before Phase 4/5 work assumes a single undifferentiated warehouse
  pool. **This is a first-class requirement, not a footnote** — see the
  sub-section immediately below.
- **Every new index, RLS policy, and query added from now on should be
  reasoned about at 100-store cardinality**, not validated only against
  the 2-store local fixture. The local fixture is for correctness
  verification, not a proxy for scale behavior.

Nothing above has been retrofitted into the code that already exists as of
this entry — it is the design bar for everything built from this point on,
and a punch list for revisiting the store-list/warehouse assumptions baked
into Phase 1–5 work once there's bandwidth to do it deliberately rather than
as a rushed reaction.

### Geography-aware replenishment — restated 2026-08-15

The multi-warehouse half of the scale target was under-weighted above and
was restated explicitly by the user: the app must be eligible for 100+
stores **and** multiple warehouses, and replenishment should use
**pincodes to route a store's refill from the nearest warehouse**. That
is a requirement about *sourcing*, not just about counting stock, and it
changes the shape of the allocation problem rather than adding a column
to it.

- **Warehouses become first-class entities.** Each needs its own
  identity, location (pincode / geo coordinates), capacity and stock —
  none of which the current schema models. Today "warehouse" is an
  inferred category (any branch that isn't a known store), which is a
  reasonable call for one undifferentiated pool and does not extend to
  many warehouses that must be told apart, ranked and drawn from
  independently.
- **Stores need a location attribute too.** "Nearest warehouse" is
  meaningless unless the store side of the pair also carries a pincode or
  geo reference. That is a schema addition to the store/branch model, not
  only to the warehouse model.
- **Allocation must become distance- or pincode-aware.** A store's refill
  should be sourced from the nearest warehouse that actually holds the
  stock — with a fallback to the next-nearest when the closest one is
  short — instead of computing against a single network-wide pool and
  ignoring where the units physically are.
- **"Nearest" is an open design decision, deliberately not made here.**
  The plausible options are pincode proximity (numeric/prefix distance),
  an explicit warehouse→service-region mapping maintained by the business,
  or a real distance calculation from geocoded coordinates. These differ
  sharply in data requirements, maintenance burden and accuracy. Picking
  one is a business/ops decision — see Open decisions item 3.
- **The row-volume problem and the sourcing problem must be solved
  together.** `web/lib/replenishment/compute.ts` (priority / cover-days)
  and `web/lib/replenishment/mix.ts` both currently compute against one
  network-wide stock pool and already pull up to 40,000 stock rows and
  100,000 sale rows — flagged above as a correctness deadline at 100+
  stores. Multi-warehouse sourcing makes both worse at once: more rows
  (stock now has to be resolved per warehouse, not summed) *and* harder
  logic (allocation becomes a per-store choice among ranked sources).
  Solving the aggregation push-down first and then retrofitting geography,
  or the reverse, means rewriting the same code twice — Phase 1c's
  deferred SQL-side aggregation work and the warehouse design pass should
  be scoped as one piece of work.

None of this is implemented. It is a requirement statement and a punch
list, recorded so that Phase 4/5 work does not quietly assume a single
warehouse.

## Product references

Combine the strongest concepts from: **Power BI** (personalization,
slicers, self-service), **Tableau** (visual exploration), **Looker**
(governed semantic layer), **Sigma** (flexible workbooks), **ThoughtSpot**
(natural-language exploration), modern **Next.js** (streaming, Suspense,
granular caching). Do not clone any of these — use their architectural
principles for a retail-specific system.

**Visual design** follows the **Shopify Admin** reference specifically
(2026-08-15 direction): dark top bar with brand mark and user identity,
white sidebar with rounded active-item pills and icon+label nav, light-gray
page ground with white rounded cards, pill-shaped buttons. See
`web/components/ui/AppShell.tsx` as the single file that carries this
theme app-wide.

## Report-builder UX reference — added 2026-08-15

The user walked through **Shopify Admin's Analytics → Reports** area as a
conceptual reference for how this project's custom report / exploration
builder should feel. Their framing was explicit: *"just to refer... no
need to copy all just refer the concept."* This section is about the
**interaction model** — the Product references section above cites the
same product for **visual design** (chrome, colors, card shapes). Those
are two different borrowings from one source; neither supersedes the
other, and neither is a mandate to clone the product screen for screen.

What the reference actually shows, as observed — not a wish list:

- A **reports list page**: a searchable table of saved reports with
  columns for Name, Category (Orders / Sales / Inventory / Finances /
  Acquisition / Customers / Behavior), Last viewed, and Created by —
  the last one distinguishing platform-authored reports from ones the
  org's own users wrote. Filter chips for "Created by" and "Category",
  and a prominent "New exploration" button.
- A **"New exploration" builder**: result canvas on the left, a
  right-hand **Controls** panel with two tabs, **Freeform** and
  **Cohorts**.
  - Freeform stacks four pickers — **Metrics**, **Dimensions**,
    **Visualization**, **Filters** — each with a `+` affordance.
  - The Metrics picker opens a searchable, category-grouped list
    (Customers, Finance and payments, Fraud prevention, Inventory,
    Marketing, Orders, Products, Sales revenue, Sessions and behavior,
    Stores) that drills into individual metrics, with a hover preview
    pane explaining what a category or metric means, and explicit
    **Clear / Apply** buttons — deferred commit, not apply-on-click.
  - Cohorts swaps the panel to a cohort-specific shape: one Metric
    picker, a "Cohort definition" (e.g. First order), Visualization, and
    Interval (e.g. Month), rendering a retention-style cohort chart plus
    a cohort table.
  - Empty state reads "Start by adding a metric" — the canvas stays
    inert until the configuration is valid.
  - Global controls sit above the canvas: date range, a comparison
    picker ("No comparison" / "Compare: Individual cohorts"), and a
    currency selector.
  - Unsaved edits raise a sticky **Unsaved changes / Discard / Save**
    bar — an exploration is a draft until someone saves it.
  - One screen shows the **generated query rendered as editable code**
    with a "Valid query" status indicator, alongside a natural-language
    "Refine query" input. The NL prompt and the structured pickers are
    two views of the *same* underlying query object, and the generated
    query is shown to the user rather than hidden behind the UI.
  - A separate assistant side panel ("Sidekick") with its own
    conversation history, for natural-language exploration.

### How it maps onto what this project already has

- `workspace.component_definitions` (migration 0047) is the component
  catalogue — the governed list of *what can be rendered*.
- `workspace.metric_definitions` and `workspace.dimension_definitions`
  (migration 0048) are exactly the governed vocabulary a Metrics /
  Dimensions picker would read from. That layer already exists for a
  different reason (cited KPI definitions), and it is the right source of
  truth for a picker — a builder must not invent metrics outside it.
- `web/lib/workspace/queryPlanner.ts` (Phase 4) is the piece that would
  turn a chosen metric + dimension + filter set into physical queries.
  A builder UI is, mechanically, a way of authoring the planner's input.
- The existing `/workspace` page is a **saved grid of components** model.
  An "exploration" — ad-hoc, metric-first, unsaved until explicitly
  saved — is a **different and additional surface**, not a rename or
  reskin of what exists. Both can share the semantic layer and the query
  planner underneath; conflating them at the UI level would break the
  saved-workspace behavior that is already specified.

### What is genuinely absent today (all new work)

Nothing in this section is implemented. The pieces with no counterpart
in the current codebase or schema:

- a saved-report / exploration list, with authorship and last-viewed
  metadata (nothing records who authored a workspace artifact or when it
  was last opened);
- category-grouped, searchable metric picking with an explanatory
  preview — the metric definitions exist, a browsing UI over them does
  not;
- user-chosen visualization type (components currently carry their own
  fixed rendering);
- cohort analysis of any kind, including the cohort-definition and
  interval concepts;
- a draft / unsaved-changes model with discard;
- showing the generated query back to the user, in any form.

One thing is *not* new: the deferred-commit **Clear / Apply** behavior in
the metrics picker is the same pattern this codebase already adopted
deliberately for its multi-select filters — checkboxes batch into a
single refresh on Apply rather than refetching per click (see HANDOFF's
2026-08-13 entry; it was the fix for "multiple store filter taking too
much time"). Adopting it in a builder is consistency with an existing
decision, not a new idea, and it matters more at 100+ stores, not less.

## Filter engine — Phase 6, built 2026-08-15

The governed filter engine is in. A workspace filter is a
`{ dimensionId, values }` predicate resolved against
`workspace.dimension_definitions`, applied by
`web/lib/workspace/queryPlanner.ts` to whichever view each component reads.

The governing rule, and the reason most of the code exists: **the planner
never silently drops a filter it cannot express.** A dimension catalogued
against a different view (e.g. `gender`, which lives on
`sales.vw_item_gender_options` and needs a join this planner does not do)
is reported in `unappliedDimensionIds`, `isSatisfiable()` returns false, and
`buildQuery()` throws. Dropping the predicate instead would return
unfiltered rows that *look* filtered — a wrong number on screen with nothing
visibly broken, which is the exact failure mode the semantic layer exists to
prevent. Filter values are also part of the query grouping key, so two
components filtered differently can never share one physical query.

Verified by `web/scripts/verify-filter-engine.mjs` against live data.

Known gap, deliberately left visible: the weekly-backed components (KPI
grid, store league, week series) are still fetched by hand and cannot honour
a governed filter, because a metric carries only ONE `source_view` and
net_sales/sale_bills/etc. are catalogued at the daily grain. Rather than
render those unfiltered next to a correctly-filtered chart,
`renderSalesComponents.tsx` throws if such a filter is ever active. Nothing
in the UI can save a non-store/date filter yet, so this cannot fire today —
it is a tripwire for whoever builds the governed-filter UI. Closing it
properly needs multi-grain metric modelling ("this metric exists at these
grains, roll up via this view"), which is the next real Phase 4 design step.

Also fixed here: the workspace store picker was a flat checkbox list of
every store — a direct violation of the Scale target above. It now has
search-to-filter (name and id), a 50-row render cap with reveal, bulk
actions scoped to the current search rather than the whole list, and a
count-pill instead of unbounded chips past 5 selections. The deferred-commit
behaviour (batch on close, never one write per click) is unchanged.

## Sharing — Phase 7, built 2026-08-15

`workspace.workspace_permissions` (migration 0052) plus a security fix
(0053). Read-only sharing to named users, and "personalize a copy" as a
fork — which is how the acceptance bar's *official dashboards stay unchanged
when a user personalizes a copy* is satisfied: there is no shared-edit path
at all, so a shared workspace cannot be mutated by a grantee.

**The security property to preserve above all else: sharing conveys LAYOUT,
never DATA.** A workspace stores which components sit where and a filter
scope; it stores no figures. Every number is fetched per request through
views scoped by `core.fn_user_store_ids()` *for the viewer*. So an ho_admin
sharing a network workspace with an ebo_manager gives them the same cards
scoped to their own store — not the ho_admin's totals. Nothing runs as the
owner; `fn_fork_workspace` is deliberately SECURITY INVOKER so a fork can
only copy what the caller could already read. If someone ever reports
"a shared workspace shows different numbers to different people", that
difference *is* the security model — do not fix it by executing as the owner.

Deliberately narrow, following 0049's precedent: `capability` is
CHECK-constrained to `'view'` and `principal_type` `'role'` has no policies,
so neither can silently half-work. Grantees cannot re-share.

### A real privilege-escalation bug, found and fixed the same day

0052 as first written was exploitable, and it is worth recording why so the
mistake isn't repeated. The grant table carried a denormalized `owner_id`
(to avoid an RLS recursion cycle between `workspaces` and
`workspace_permissions`), protected only by
`with check (owner_id = core.current_user_id())`.

That check proves the caller wrote *their own* id into the column — not that
they own the workspace. Any authenticated user could insert a grant naming
themselves as owner for **any** workspace id and hand it to anyone; combined
with fork, they could then copy it. 0052's own comment claimed a wrong
`owner_id` "grants nothing extra" — false, since `owner_id` *was* the entire
link between a grant and the real owner.

Fixed in 0053 with a BEFORE INSERT/UPDATE trigger that verifies the caller
owns the workspace and **overwrites** `owner_id`/`granted_by` server-side, so
forgery is impossible by construction rather than merely validated. The
policies additionally require a grant's `owner_id` to match the workspace's
current owner, as defense in depth.

The lesson worth carrying: **a denormalized column used in an authorization
decision must be server-derived, never client-supplied.** RLS `WITH CHECK`
constrains what a row may contain, which is not the same as constraining who
may write it.

Regression test: `server/db/tests/rls_workspace_sharing.sql` — 9 groups
covering no-grant isolation, forgery, read-only enforcement, re-share,
fork independence, and revocation. It caught this bug before any
application code depended on the broken behavior. Run it after any change to
workspace RLS:
`psql -U postgres -h 127.0.0.1 -p 5432 -d ebo_bi -f server/db/tests/rls_workspace_sharing.sql`

## Measured progress against the acceptance bar — 2026-08-15

Where the bar below is actually met today, with the evidence rather than an
assertion:

- **Query minimisation is real and measured.** Routing the Workspace's
  daily / scheme / hourly fetches through the Phase 4 planner narrowed the
  select lists from `*` to named columns: daily **21 -> 3** columns per row,
  hourly 6 -> 4, scheme 8 -> 5, over 56 / 388 / 221 rows respectively on a
  realistic fixture. An equivalence harness confirms the planner-built
  queries feed the shared aggregate functions byte-identical input to the
  hand-written queries they replaced, so `/workspace` and `/network` cannot
  disagree.
- **A failing component degrades rather than lying.** The planner refuses to
  build a query that would drop a requested filter, and the weekly-backed
  components throw rather than render unfiltered data beside filtered data.
- **RLS is enforced and proven**, not assumed — see the Phase 7 test.

Not yet met, and honestly still open:

- The weekly-grain components cannot honour governed filters (multi-grain
  metric modelling is the prerequisite — see the Phase 6 section).
- Nothing here has been validated at 100-store cardinality. The local
  fixture is two stores; the Scale target remains a design bar, not a
  measured result.
- No logged-in browser walkthrough of `/workspace` vs `/network` has been
  done — every verification above is script-level against live data.

## What "done" looks like (acceptance bar, unchanged from the blueprint)

- Existing KPI definitions remain correct; RLS remains enforced;
  unauthorized data cannot be reached through a custom component or filter.
- Page shells appear immediately; slow components never block fast ones;
  queries are minimized; large datasets are not pulled into the browser
  unnecessarily — **and this holds at 100+ store scale, not just at 2.**
- Users can build, save, and restore a personal workspace from governed
  components; official dashboards stay unchanged when a user personalizes
  a copy.
- A single failing component degrades gracefully — it never takes the rest
  of the page down.

## Where the detailed plan lives

- **Phase 0 audit + full target architecture**: the "Retail Intelligence
  Workspace Blueprint" artifact (published this session).
- **Business-logic register** (every KPI formula, cited): same artifact,
  §E, mirrored into `workspace.metric_definitions` (migration 0048).
- **Component catalogue**: `workspace.component_definitions`
  (migration 0047).
- **Operational handoff notes** (server access, known gotchas, deploy
  history): `HANDOFF.md` — that file is about *how to operate this
  environment*; this file is about *what we're building and why*. Don't
  duplicate content between them.

## Item master as product-detail authority + dynamic Fresh/EOSS setting — 2026-08-15

Resolved Open Decision #1 (below) and removed the remaining hardcoded
category/scheme rules, per explicit user direction after real ERP data
(23,410 sale lines, 3 real branches, 93,291 `item_master` rows) was loaded:

- **Migration 0055**: dropped `ops.vw_monthly_fresh_disc_tracker`'s hardcoded
  6-item accessory exclusion — it now matches
  `ops.fn_monthly_fresh_disc_tracker`'s already-live, user-selectable-only
  behavior (0037). Confirmed zero live application callers of the view, so
  this carried no runtime risk.
- **Migration 0056**: `raw_logic.item_master` (barcode/`item_code`-keyed,
  landed by 0054 but wired into nothing) is now the authoritative
  product-detail source, joined by barcode everywhere the app reads
  category/subcategory/gender/item_name/shade/season/market_segment/
  size_group — three view choke-points (`sales.vw_ebo_sales_lines`,
  `sales.vw_item_subcategory_lookup`, `sales.vw_stock_with_scheme`), with
  fallback to each view's prior source for any barcode not yet in
  `item_master` (2 of 23,410 sale-line barcodes today). `item_master.mrp` is
  never read anywhere — MRP/rate stay transactional, per explicit
  instruction.
- **Migrations 0057–0059**: new `core.app_settings` table (first
  generic settings table in the project) backs a new admin-only
  **Configurations** nav section (`/configurations`, `super_admin`-only,
  cloned from the `(admin)` layout template). Its first setting,
  `fresh_disc_classification_source`, makes the Fresh-vs-EOSS classification
  source a runtime choice (`discount_ratio`, today's default, vs.
  `scheme_lookup`-based) instead of hardcoded SQL — `ops.fn_monthly_fresh_disc_tracker`
  and `ops.vw_monthly_fresh_disc_audit_lines` both read the same setting so
  they can never disagree. Verified end-to-end in the browser (save
  persisted, tracker function output changed correctly under both settings);
  caught and fixed a real bug along the way — 0057 forgot `service_role`'s
  plain Postgres GRANT on the new table (RLS bypass and GRANTs are
  independent, per 0045's own documented lesson), fixed in 0059. Left the
  setting at `discount_ratio` (the safe default) after testing.
- **Follow-up resolved 2026-08-15**: the old synthetic parity fixture rows
  (`SB-1001`/`SB-1002` sale lines + the `BO-001`/2026-08-10 footfall row)
  were deleted per explicit direction, now that real data supersedes them.
  `parity-check.mjs` and `verify-query-planner.mjs` are marked RETIRED in
  their own headers for the literal-value assertions that depended on the
  now-gone fixture (they will fail against real data by design, not as a
  bug) — their grouping/structural/internal-consistency checks remain
  meaningful and still pass. Restoring full parity coverage needs a new
  fixture at a store/date confirmed to have zero real rows, independently
  verified against a live page render — not yet done, and not required
  unless full metric-parity coverage becomes a blocker again.

## Phase 8 (smart components/drilldown) and Phase 9 (performance-aware) — 2026-08-15

- **Phase 8 slice, verified**: Store League Table rows in the Workspace
  builder are now clickable, opening a focus panel with that store's own
  daily net-sales trend (`lib/workspace/drilldown.ts` +
  `StoreLeagueDrilldown.tsx`). Confirmed in-browser that the query fires
  exactly on click (a Server Action call), never before — the roadmap's
  exit gate verbatim. Only this one component is wired; the same pattern
  can extend to the other 5 when wanted, not done unprompted.
- **Phase 9 slice, verified**: every workspace card's content now mounts via
  `LazyMount` (`(workspace)/workspace/LazyMount.tsx`) — deferred until the
  card is within 200px of the viewport, with a synchronous
  `getBoundingClientRect` fallback alongside the `IntersectionObserver` so
  above-the-fold cards mount immediately without a skeleton flash. Each
  card also shows its `workspace.component_definitions.cost` tier as a
  badge (low/medium/high), surfacing data that already existed in the
  registry but was never shown anywhere. **Scope stated plainly**: this
  defers DOM mount (real layout/paint cost), not the underlying data
  query — every added component's data is still fetched in one shared
  server-side `Promise.all` regardless of scroll position. Deferring the
  fetch itself needs per-component streaming (the same shape as the Phase 8
  drilldown pattern, applied to initial load), not done here. A real bug
  was caught and fixed during verification: a bare `IntersectionObserver`
  never fired at all in the non-focused preview pane used for testing —
  the synchronous fallback exists because of that, and makes the feature
  more correct generally, not just a workaround for the test environment.
- **Phases 10–12 (AI workspace builder → AI analysis → AI optimisation)**:
  the roadmap's own exit gate for these is explicit — "not started until
  the governed layers are stable in production." Nothing here is in
  production; everything so far has run against the local dev stack only.
  Not started, and flagged rather than silently begun or silently skipped.

## UI/UX quality pass — Tremor charts, 2026-08-15

User feedback: the app's visual layer read as "engineer-built, not
designer-built" — accurate, since `--font-serif` was aliased to the same
system font as `--font-sans` (no real typographic identity at all) and both
charts were hand-rolled inline SVG rather than a real charting library.
Fixed the charts first (highest-leverage, user-selected option): installed
`@tremor/react` + `@headlessui/tailwindcss`, added the standard Tremor
Tailwind config block (color scale, safelist, shadows/radius/font-size
tokens — coexists with the app's own `--accent` etc. token system, doesn't
replace it). `components/ui/TrendChart.tsx` and `HourlyBarChart.tsx` were
reimplemented internally using Tremor's `AreaChart`/`BarChart`, keeping the
EXACT same external contract (`points`, `ariaLabel`) so every caller —
Network's SalesSection, the Workspace's chart components, the Phase 8 store
drilldown panel — needed zero changes. Verified in-browser: real axis
gridlines and formatted currency ticks now render, all underlying figures
unchanged.

**Not yet done, flagged rather than silently skipped**: the typography gap
(no real display/body font pairing) — still open.

## UI stack upgrade — shadcn/ui + AG Grid Community, 2026-08-15

User evaluated an alternative stack (shadcn/ui + ECharts + AG Grid
Community) against the Tremor-only approach above. Verdict, recorded for
future phases: AG Grid is a real structural fix (this app has no
virtualization anywhere, flagged in the Scale target section above — AG
Grid gives it for free), shadcn/ui is a better long-term foundation than
Tremor for non-chart UI (own the component code, matches this project's
existing philosophy, actively maintained — classic `@tremor/react` v3 is
effectively legacy now that Tremor's own investment moved to "Tremor Raw",
which needs Tailwind v4 and doesn't fit this v3 project). ECharts held back
for a future pass on the heatmap-style matrices (footfall×conversion,
traffic×sales) where Tremor has no equivalent — not a wholesale chart
replacement, since the Tremor charts already installed and verified working
weren't worth the churn.

Built: `lib/utils.ts` (`cn()`), and hand-authored shadcn-shaped primitives
(`components/ui/button.tsx`, `card.tsx`, `badge.tsx`, `dialog.tsx`) —
**deliberately NOT using shadcn's usual `--primary`/`--card`/etc. CSS
variable set**, since this app already has a mature, actively-referenced
token system (`--accent`, `--surface-2`, `--crit`, etc.) and duplicating it
under different names would be a second, driftable source of truth. Every
primitive is authored directly against the existing tokens instead.
`components/ui/DataGrid.tsx` wraps AG Grid Community (v36, the new
Theming API — `themeQuartz.withParams({...})` pinned to the app's light-mode
hex values, since AG Grid's JS-evaluated theming can't read Tailwind CSS
custom properties).

First real usage, verified end-to-end in-browser (zero console errors on a
clean load): the Workspace's Store League table — real AG Grid (sortable
columns, ready for virtualization at scale) inside a Radix Dialog (real
focus trap/ESC/portal) replacing the original hand-rolled `<table>` +
fixed-overlay div, plus `Button`/`Badge` wired into the Workspace's
add-component/save/reset/cost-indicator controls. A real bug was caught and
fixed during this verification: the hand-authored `DialogOverlay`/
`DialogContent` needed `React.forwardRef` (Radix's Portal/Presence chain
passes a ref through) — a plain function component threw "Function
components cannot be given refs" and broke the dialog, caught by an actual
click test, not assumed from copying the shadcn pattern.

**Scope, stated plainly**: only ONE table (Store League) has been converted
to AG Grid so far. The other dense tables this app has — Weekly Sales,
Stock Details breakdowns, Replenishment recommendations, the Targets
tracker — are still plain HTML `<table>` markup and are the natural next
candidates, given they're exactly where the "wall of cards at 100 stores"
scale problem lives. Not done unprompted; this was the first proof slice.

## Sale vs Stock Mix — Store SOH / WH SOH split, 2026-08-15

Small, additive change: `lib/replenishment/mix.ts`'s `MixRow.warehouseAvailable`
was already computed every page load (warehouse stock, summed per style+color,
was already used internally to gate the "Warehouse Stock Unavailable" action
label) but never rendered as its own number. `sale-stock-mix/page.tsx`'s
single "SOH" column is now two: "Store SOH" (unchanged — `r.soh`, store-only,
as documented in `mix.ts`'s own header comment) and "WH SOH" (`r.warehouseAvailable`,
newly surfaced). No new query, no schema change, no aggregation logic
touched — purely exposing already-computed data. Verified live: distinct
real values per row (e.g. Store SOH 6 / WH SOH 152 for one style-color).

## Workspace: switcher, consolidated toolbar, 2 new component families — 2026-08-15

Debug sweep across all 12 pages: clean (only harmless dev-mode HMR 404
noise, present uniformly on every route). Then, per the approved plan
(`enchanted-leaping-mochi.md`):

- **Workspace list/switcher, closing a real gap**: per-user saving was
  already correct (owner-scoped RLS, confirmed) — the actual gap was zero
  UI to see/create/rename multiple workspaces or browse what's shared with
  you. `lib/workspace/actions.ts` gained `listMyWorkspaces`,
  `createWorkspace`, `renameWorkspace`, `getWorkspaceById`; `page.tsx` now
  reads `?workspaceId=`, falling back to the default exactly as before if
  absent or unreadable. New `WorkspaceSwitcher.tsx` surfaces "My
  workspaces", "Shared with me" (Phase 7's `listSharedWithMe`, built
  months ago, never called from any page until now), "+ New workspace",
  and inline rename. Verified live: dropdown lists workspaces, switching
  and adding components both confirmed working.
- **Consolidated toolbar**: "Add component" and "Save layout"/"Reset
  workspace" used to live in two disconnected rows/components — a real UX
  inconsistency, not just a preference. Now one row
  (`WorkspaceGridClient.tsx` renders `AddComponentPicker` via a
  `toolbarExtra` prop rather than page.tsx rendering it separately).
- **Two new, non-Sales component families**, first real expansion beyond
  the original 6 Sales-only components:
  - `gender_split_card` (Stock) — substituted in place of the plan's
    original `stock_vs_capacity_table` pick: cheaper (registry `cost:
    medium` vs `high`), single query, and matches the catalogued
    description exactly ("Girls vs Boys share of ... current stock").
    Reuses `buildDcMatrix`/`buildNibmSummary` from
    `lib/stockDetails/aggregate.ts` verbatim.
  - `sale_stock_mix_table` (Mix) — reuses `computeSaleStockMix` from
    `lib/replenishment/mix.ts` verbatim, capped to the top 15 rows by mix
    gap for a workspace-tile size. Verified byte-identical values against
    the standalone `/sale-stock-mix` page for the same store.
  - `replenishment_kpi_grid` deliberately NOT added — no lighter summary
    function exists; it would require running the full 40k/100k-row
    allocation engine a THIRD time per workspace render, compounding the
    scale risk already on record above. Flagged as follow-up needing a
    real SQL-side aggregate, not built the expensive way.
  - Both new components' data fetches are gated the same way Sales
    already is (`needsStockData`/`needsMixData`) — only fetched when a
    component of that family is actually present.
  - Both take a SINGLE store or "all stores combined" (their source
    functions' own scope shape, `computeSaleStockMix`/`buildDcMatrix`
    don't support a multi-store list) — the card says so plainly rather
    than silently misrepresenting a multi-store selection.

**Honestly not covered by this pass** (stated in the plan up front, not
discovered as a surprise): the full-app typography/visual-identity gap
from the earlier UI critique is untouched — this pass changed the
Workspace page's structure and variety, not the app's overall visual
language. 16 more catalogued components still have no renderer.

## Real typography, closing the earlier UI critique — 2026-08-15

Fixed the exact bug the UI critique surfaced: `globals.css`'s `--font-serif`
was aliased to the identical system-UI stack as `--font-sans`, so every
heading across 18 files styled `font-serif` silently rendered as plain
system text — no typographic identity anywhere in the app. `globals.css`'s
own header comment already said the token system was "carried over
verbatim from the screen mockups," so a real serif/sans pairing was always
the intent, just never wired up.

New `lib/fonts.ts` loads three real typefaces via `next/font/google`
(self-hosted at build time, no runtime Google Fonts request — works fine
in this all-local dev stack): **Newsreader** (display serif, headings),
**IBM Plex Sans** (body/UI), **IBM Plex Mono** (tabular numbers —
currency, discount %, every KPI figure). Deliberately NOT the generic
AI-default set (Inter, Space Grotesk) — IBM Plex is a real enterprise
typeface family, Newsreader has genuine character at heading sizes without
reading as decorative. `variable` names match the EXISTING token names
exactly (`--font-serif`/`--font-sans`/`--font-mono`), applied via a
className on `<html>` in `app/layout.tsx` — every component and
`tailwind.config.ts`'s `fontFamily` mapping that already referenced these
tokens picked it up with zero other changes. `globals.css`'s old hardcoded
system-stack fallbacks for these three were removed (next/font is now the
sole definition).

Verified live via computed styles (not just "it compiled"): login page's
h1 resolves to the real Newsreader font family, Network's KPI figures
resolve to the real IBM Plex Mono family, `--font-serif`/`--font-sans` are
now genuinely different values (previously identical) — across multiple
pages, zero console errors.

## Type rhythm + spacing pass — 2026-08-15

Follow-up to the real-fonts fix above: real typefaces existed but nothing
had tuned how they're actually used, so the app still read dense/
utilitarian. Deliberately GLOBAL fixes rather than rewriting 40+ files'
worth of arbitrary `text-[Npx]` utilities — same leverage principle used
throughout this project (fix the shared token/class, every page inherits
it):

- `globals.css`: `body` now sets an explicit baseline `font-size: 14.5px`
  / `line-height: 1.55` (previously undefined, falling back to browser
  defaults inconsistently against dozens of files' own overrides). A new
  `.font-serif` rule (the exact shared class all 18 page-heading `<h1>`s
  already use) gives Newsreader real presence: `font-weight: 500`,
  tightened `letter-spacing`, `line-height: 1.2`, `text-wrap: balance` —
  reaches every heading in the app from one rule, not 18 file edits.
- `KpiCard.tsx` (the shared component nearly every page's headline numbers
  render through): value size 24px → 26px, more breathing room top/bottom
  and around the sub-label.
- `AppShell.tsx`'s page container: `max-w-[1240px] px-6` →
  `max-w-[1280px] px-8` — slightly more horizontal room app-wide.

Caught and fixed a real regression during verification, unrelated to the
CSS itself: repeatedly stopping/restarting the dev server had corrupted
the Next.js `.next` build cache (`Cannot find module
'./vendor-chunks/tailwind-merge...'`, a webpack vendor-chunk resolution
error, not a real missing dependency — `tailwind-merge` was already
installed and typechecking clean). Fixed by clearing `.next` and
restarting; confirmed the corruption was cache-only, not a real bug, by
reproducing a clean build afterward with zero errors.

Verified live via computed styles across Network and Workspace: real
weight/letter-spacing/line-height values applied, zero console errors on
a clean build.

## Open decisions (not mine to make)

1. ~~**Accessory-exclusion divergence**~~ — **resolved 2026-08-15**, see above.
2. **Production verification**: which `core.current_user_id()` definition
   is actually live in production (0003's self-hosted version, or 0044's
   retracted Supabase-only version) has not been confirmed — this session
   has only ever run against the local dev stack described below.
3. **Is ATV meant to net off returns?** — surfaced 2026-08-15 while
   correcting the semantic layer (migration 0050). Production computes ATV
   two different ways and the app only ever renders one of them:
   `sales.vw_ebo_sales_daily.atv` (0005:106) divides by sale bills but uses
   a **returns-excluded** numerator, while
   `sales.vw_ebo_sales_weekly.atv` (0005:133) uses a **returns-netted**
   numerator over the same denominator. They agree only when a scope has
   no return bills. Every page shows the weekly (returns-netted) figure,
   so the catalogue was repointed to match what users actually see — that
   part is settled and no displayed number changed. What is NOT settled is
   whether returns-netted is the definition the business *intends* for
   "average transaction value". If it is not, the fix is a view change and
   a visible number change, which is explicitly not a call to make from
   the code side. The daily variant is registered separately as
   `atv_sale_bills_only` so both remain nameable while this is open.

   **Measured, not theoretical (2026-08-15).** On a seeded returns-bearing
   fixture the two formulas produced ATV **3097.94 vs 3009.79** over one
   store-week on returns of -2997 — roughly a 2.8% divergence. A further
   finding sharpens the choice: the weekly formula the app displays divides
   a returns-INCLUSIVE numerator by a SALE-ONLY denominator, because
   `net_sales` spans all bill types while `sale_bills` counts only SALE
   bills. That is a **mixed-basis ratio**. Of the three self-consistent
   options — sale-only over sale bills, net over all bills, or the current
   hybrid — the hybrid is the hardest to defend. The code-side
   recommendation is sale-only over sale bills, with return rate tracked as
   its own metric; but it changes a number on screen, so the ruling is the
   business's.
4. **Warehouse modeling and geography-aware sourcing** (see Scale target
   above, and "Geography-aware replenishment") — needs a design pass, not
   a unilateral schema decision. Two rulings are needed, and they are
   business decisions rather than engineering ones:
   (a) how multiple warehouses are modeled as first-class entities
   (identity, pincode/geo, capacity, stock, transfer rules), and
   (b) what **"nearest warehouse" formally means** for replenishment —
   pincode proximity, an explicitly maintained warehouse→service-region
   mapping, or a real geocoded distance calculation. Each implies
   different master data the business has to supply and maintain, so
   this is not a choice to make from the code side.

## Environment note

All work this session runs against an **all-local dev stack** on this PC
(Postgres/Keycloak/PostgREST/MinIO under `D:\Programs`, `web/.env.local`
points entirely at `localhost`) — completely isolated from
`192.168.1.16`/production. Nothing here has been deployed anywhere. See
`web/.env.local`'s own header comment for exact service locations and the
test login.
