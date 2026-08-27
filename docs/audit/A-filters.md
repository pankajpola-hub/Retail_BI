# Audit A — Filters & URL State

**Date:** 2026-08-27
**Commit:** `014b1c5` (branch `master`)
**Repo:** `D:\Py\Sales & Marketing dashboard_Test` — Next.js 14 app router, code under `web/`
**Files reviewed:** 34 (19 page routes + 8 shared filter/grid components + 7 lib modules)

Every finding below carries either a `file:line` citation with the code quoted verbatim, or a
reproduction that was actually executed with its output pasted in.

---

## Summary table

| ID | Sev | Page / Area | One-line | Status |
|----|-----|-------------|----------|--------|
| A-01 | P1 | `DateRangePicker.tsx` (every page with a date filter) | Presets serialize local-midnight dates via `toISOString()` → every preset is off by one day in IST | CONFIRMED (was F1) |
| A-02 | P1 | `/sales` product-attribute table | Facet key is positional (`attr0`); changing the "View by" combo re-applies the old value to a new attribute → empty table + impossible chip | CONFIRMED (was F2) |
| A-03 | P1 | `FacetFilterBar.tsx` advanced filter | An empty-valued numeric condition filters to `value === 0`, because `Number("") === 0`; blanks the `/sales` Ecomm channel table on "+ Add condition", and every faceted table on a field switch | NEW |
| A-04 | P1 | `/sales` — every query but one | No `.range()` pagination: widening the date filter silently truncates at PostgREST's 1000-row cap → wrong KPI/table numbers | NEW |
| A-05 | P1 | `/sales` Ecomm "By channel" table | `c.cancelled` is never incremented → "Cancelled" and "Cancel %" are permanently 0 | CONFIRMED |
| A-06 | P2 | `/movement` Sale-vs-Stock-Mix | Activating a "View by" combo unmounts the whole FacetFilterBar; filters silently stop applying | CONFIRMED (was F6) |
| A-07 | P2 | `/movement` Replenishment tab | "Recalculate" GET forms carry no `mix_*` hidden inputs → wipe the Mix tab's state; the `buildHref` fix exists but is dead code | CONFIRMED (was F5) |
| A-08 | P2 | `/sales` channel scope | With EBO+ECOM both active the channel picker is not rendered, but `?channels=` keeps filtering every ecomm query, with no in-app way to clear it | CONFIRMED, with nuance (was F4) |
| A-09 | P2 | Both date pickers | Custom From/To inputs never re-sync to a changed URL; changing the main range leaves a stale comparison range | CONFIRMED (was F3) |
| A-10 | P2 | `FacetFilterBar.tsx` text conditions | Empty-value text condition matches every row while still rendering an "active" chip; no "is blank" operator for text | CONFIRMED |
| A-11 | P3 | `FacetFilterBar.tsx` facet panel | "Select all" while the facet search box is filled *replaces* the selection, erasing picks outside the search | CONFIRMED |
| A-12 | P3 | `/sales` `channelHref` | Bakes the resolved default 30-day window permanently into the URL | CONFIRMED |
| A-13 | P3 | `/sales` period table | Saved views are keyed per calendar grain (`sales_period_${grain}`) | CONFIRMED |
| A-14 | P3 | `FacetFilterBar.tsx` | Facet values that are `""` are unlistable but still excluded by any active facet selection | NEW |
| A-15 | P3 | `savedViews/actions.ts` | `revalidatePath("/movement")` hard-coded — wrong path for `/sales` and `/network` saved views | NEW |
| A-16 | P3 | `/movement` mix form | Hidden inputs emit `targetCover=&leadTime=&…` — a dozen empty params on every Apply | NEW |
| A-17 | P3 | `/movement` | `mix_style`/`mix_color`/`mix_status`/`mix_page`/`mix_perPage` are declared and forwarded but read by nothing — dead URL params, and Mix-tab filter state is not URL-addressable at all | NEW |
| A-18 | P3 | `FacetFilterBar.tsx` | "Clear all" (next to the chips) also silently clears Group-by levels, which have no chips in that row | NEW |
| A-19 | P3 | `/sales` Ecomm top-styles | `units` counts CANCELLED lines, `net` excludes them — the two columns disagree | NEW |
| A-20 | — | `/footfall` | **WITHDRAWN** — drafted, then disproved on inspection; `/footfall` uses the client pickers and validates `?store=` correctly | WITHDRAWN |
| A-21 | P3 | `/targets` | An absent `gender`/`category` param means "apply a default filter", so a bare `/targets` URL is silently pre-filtered to FEMALE + APPAREL (deliberate and documented) | NEW |
| A-22 | P3 | `/stock-details` | `?store=` accepts unknown ids without validation and shows them as chips claiming a filter | NEW |

---

## Findings

### A-01 — [P1] `DateRangePicker` presets are off by one day in IST

**Was prior finding F1 — CONFIRMED.**

**Where:** `web/components/ui/DateRangePicker.tsx:8-27`

**Proof (code):**

```
  8  const iso = (d: Date) => d.toISOString().slice(0, 10);
  9  const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
 10  const endOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth() + 1, 0);
 11  const startOfQuarter = (d: Date) => new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1);
```

`new Date(y, m, 1)` builds **local** midnight; `toISOString()` converts to **UTC**. In any
timezone east of UTC that instant falls on the previous calendar day.

**Proof (executed):**

```
$ TZ="Asia/Kolkata" node -e "<the same iso/startOfMonth/endOfMonth, today = 2026-08-27T14:00+05:30>"
TZ offset mins: -330
local today: Thu Aug 27 2026 14:00:00 GMT+0530 (India Standard Time)
This month => 2026-07-31 .. 2026-08-27
Last month => 2026-06-30 .. 2026-07-30
Today at 02:00 IST => 2026-08-26 (local date is 27th)
```

**Impact:** Numbers are wrong, not just labels. "This month" silently includes 31 July's
sales; "Last month" is shifted a whole day (drops 31 July, adds 30 June); "This quarter"
starts on the last day of the previous quarter; "Last 7/30/90 days" all shift one day back.
Between 00:00 and 05:29 IST, "Today" and "Yesterday" both resolve to the previous day. The
picker writes `?from=&to=` and the server applies them with `.gte()/.lte()`, so the wrong
window reaches every query on the page. Affects every page that mounts `ScopeBar` or
`DateRangePicker` — today `/sales` (via `ScopeBar`, `sales/page.tsx:1138`) and `/footfall`.

**Root cause:** Local-constructed `Date` fed to a UTC serializer.

**Recommended fix:** In `web/components/ui/DateRangePicker.tsx` replace `iso` (line 8) with a
local-field formatter:

```ts
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
```

One line, fixes all eight presets and the custom form at once, because the preset helpers
already construct local dates. Do **not** convert the helpers to UTC instead — `presets()` is
fed `new Date()`, whose *local* fields are what the user means by "today".

**Counterpart is correct.** `ComparisonDateRangePicker.tsx` is **not** affected: its
arithmetic is UTC-anchored end to end (`web/components/ui/ComparisonDateRangePicker.tsx:20-35`):

```
 21    const d = new Date(`${isoStr}T00:00:00Z`);
 22    d.setUTCDate(d.getUTCDate() + days);
 23    return d.toISOString().slice(0, 10);
```

It never mixes local fields with a UTC serializer, so "Previous period" and "Previous year"
are timezone-independent. (Its `const iso` at line 18 is dead code — declared, never used.)

---

### A-02 — [P1] Product-attribute facet key is positional, so changing the combo mis-applies the old filter

**Was prior finding F2 — CONFIRMED, including the impossible chip label.**

**Where:** `web/app/(ho)/sales/ProductAttributeSalesTable.tsx:66-88`

**Proof (code):**

```
 66    const [combo, setCombo] = useState<SaleAttributeKey[]>(DEFAULT_SALE_ATTRIBUTE_COMBO);
 69    const [state, setState] = useState<FacetFilterState>(emptyFilterState);
...
 82    const facets = useMemo<FacetDef<SaleAttributeRow>[]>(
 83      () =>
 84        combo.length > 0
 85          ? [{ key: "attr0", label: SALE_ATTRIBUTE_COLUMN_LABELS[combo[0] as SaleAttributeKey], get: (r) => r.values[0] ?? null }]
 86          : [],
 87      [combo]
 88    );
```

The facet's **key** is the constant string `"attr0"`, while its **label** and **getter** both
follow `combo[0]`. `setCombo` (`addToCombo` 137, `removeFromCombo` 140, `reorderCombo` 147)
never touches `state`, so `state.facets["attr0"]` survives a combo change intact.

Supporting constants: `DEFAULT_SALE_ATTRIBUTE_COMBO` is `["season"]`
(`web/lib/sales/attributeBreakdown.ts:100`), and
`SALE_ATTRIBUTE_COLUMN_LABELS.season === "Season"`, `…gender === "Gender"`
(`attributeBreakdown.ts:73-80`) — so `season` yields values like `SS2026`.

**Repro (code trace):** default combo `["season"]` → open the "Season" facet → tick `SS2026`
→ `state.facets = { attr0: ["SS2026"] }`. Click the "Gender" pool chip (`addToCombo`, line 137)
→ combo `["season","gender"]`. Drag "Gender" onto index 0 (`reorderCombo`, line 147) → combo
`["gender","season"]` → the facet is now `{ key:"attr0", label:"Gender", get: r => r.values[0] }`.
`activeChips` (`FacetFilterBar.tsx:261-265`) renders literally **`Gender: SS2026`**, and
`rowMatchesFacets` (`FacetFilterBar.tsx:79`, `if (v === null || !sel.has(v)) return false;`)
rejects every row, so the grid empties. The shortest path to the same state: just remove the
leading chip — `removeFromCombo("season")` leaves combo `["gender"]` with `attr0` still holding
`"SS2026"`.

**Impact:** Table goes blank with an impossible chip and no explanation. Recoverable (click the
chip's ×) but only if the user notices.

**Root cause:** The comment at lines 76-81 justifies the positional key by claiming
"FacetFilterBar already ignores a condition whose field no longer exists". That holds for
**advanced conditions** (`FacetFilterBar.tsx:87-88`, `if (!f) return true;`) but **not** for
facets: `attr0` always exists, so the stale value is applied rather than ignored.

**Recommended fix:** In `ProductAttributeSalesTable.tsx:85`, key the facet by the attribute
itself — ``key: `attr:${combo[0]}` `` — so a combo change yields a key with no stored selection
(`rowMatchesFacets` then skips it via `sel.size === 0`). Belt and braces: clear `state.facets`
inside the three `setCombo` mutators. The advanced-condition keys `attr${i}` (lines 92-96) have
the same hazard in milder form and deserve the same treatment.

---

### A-03 — [P1] Adding a numeric advanced condition instantly filters the table to zero-valued rows

**NEW.**

**Where:** `web/components/ui/FacetFilterBar.tsx:221-225` and `:90-111`

**Proof (code):**

```
221    function addCondition() {
222      const first = advFields[0];
223      if (!first) return;
224      onChange({ ...state, conditions: [...state.conditions, { field: first.key, op: first.numeric ? "eq" : "contains", value: "" }] });
225    }
```

```
 93        const a = Number(raw);
 94        const b = Number(c.value);
 95        if (raw === null || Number.isNaN(a) || Number.isNaN(b)) return false;
 96        switch (c.op) {
 97          case "eq":
 98            return a === b;
```

**Proof (executed):**

```
$ node -e "console.log(Number(''), Number.isNaN(Number('')), Number(null), Number('  '))"
0 false 0 0
```

**Two live trigger paths, both verified against real callers:**

1. **`advFields[0]` is numeric.** Surveyed all nine `FacetFilterBar` callers; exactly one
   qualifies — `web/app/(ho)/sales/EcommChannelFacetedTable.tsx:69-71`:
   ```
    69    const advFields = useMemo<AdvField<EcommChannelRow>[]>(
    70      () => [
    71        { key: "orders", label: "Orders", get: (r) => r.orders, numeric: true },
   ```
   On the `/sales` Ecomm "By channel" table, clicking **"+ Add condition" blanks the table
   immediately** — `Orders = 0` matches nothing. (The other eight callers happen to lead with a
   text field: `StoreLeagueFacetedContent.tsx:35`, `AgentSalesFacetedTable.tsx:41`,
   `StoreDiagnosisFacetedTable.tsx:41`, `PeriodSalesFacetedTable.tsx:105`,
   `ReplenishmentFacetedContent.tsx:77`, `UsersAdmin.tsx:116`, and the two attribute tables.)

2. **Switching the field dropdown to a numeric column — affects every caller.** The field
   `onChange` resets the operator but deliberately keeps the value (`FacetFilterBar.tsx:417-420`):
   ```
   417                      onChange={(e) => {
   418                        const nf = advFields.find((x) => x.key === e.target.value);
   419                        updateCondition(i, { field: e.target.value, op: nf?.numeric ? "eq" : "contains" });
   420                      }}
   ```
   So the universal repro is: "+ Add condition" (text field, value `""`, inert) → change the
   field dropdown to any numeric column → the grid empties on the spot. The same fires whenever
   a user clears a numeric input to retype: `>`, `<`, `≥`, `≤` all silently become comparisons
   against 0 for that keystroke.

   (The mirror case is benign but untidy: switching *from* a numeric field with value `500` to a
   text field leaves a `contains "500"` condition behind.)

**Impact:** The chip reads e.g. `Orders =` — the empty value is trimmed away at line 275 — so
nothing on screen indicates a value is missing; the table simply goes blank and the user
concludes the filter builder is broken.

Note the asymmetry: the **text** branch explicitly no-ops on an empty value
(line 115, `if (!b) return true;`); the numeric branch does not.

**Root cause:** Missing empty-value guard in the numeric branch of `rowMatchesConditions`.

**Recommended fix:** In `web/components/ui/FacetFilterBar.tsx`, inside the `if (f.numeric)`
block, immediately after the `blank`/`not_blank` handling (lines 91-92) and before line 93,
add: `if (c.value === "") return true;`.

---

### A-04 — [P1] `/sales` queries have no `.range()` pagination — widening the date filter silently truncates at 1000 rows

**NEW.**

**Where:** `web/app/(ho)/sales/page.tsx:201-222`, `:852-870`

**Proof (the cap is known and a helper exists):** `web/lib/data/client.ts:78-94`

```
 78  * 1000 regardless of .limit() — confirmed live 2026-08-25 against
 80  * .limit(100000) both silently returned exactly 1000 rows, no error). Pages
 81  * through with .range() to get everything, one request per 1000 rows.
 90  export async function fetchAllRows<T>(buildQuery: () => QueryChain<T>, pageSize = 1000): Promise<T[]> {
```

**Proof (`/sales` uses it exactly once):**

```
$ grep -rn "fetchAllRows" web/app web/lib
web/app/(ho)/sales/page.tsx:4:import { createClient, fetchAllRows } from "@/lib/data/client";
web/app/(ho)/sales/page.tsx:558:  const lines = await fetchAllRows<SaleAttributeLineRow>(() =>
web/lib/replenishment/compute.ts:205
web/lib/replenishment/compute.ts:213
web/lib/replenishment/mix.ts:127
web/lib/replenishment/mix.ts:135
```

Every other `/sales` query is a bare await with no `.range()`, and the worst offender has no
`.order()` either — line 852-859, the ecomm **order-line** query behind "Top styles":

```
856        .select("channel, item_sku, style, status, selling_price, mrp, discount")
857        .gte("order_date", from)
858        .lte("order_date", to)
```

Same for the queries behind every headline KPI and the daily trend chart (lines 204, 209) and
their comparison-period twins (lines 214, 219), plus ecomm daily (864) and ecomm returns (868).

**Impact:** This is a filter bug, not only a data bug: the date-range chip claims a window, and
for any window whose result set exceeds 1000 rows the page reports numbers for an arbitrary
1000-row subset of it. Picking "Last 90 days" or "This quarter" can therefore show a **lower**
Net Sales figure than "Last 30 days" — the classic symptom. Ecomm rows are per-order-line, so
1000 is reached in days, not months. With no `.order()` on the line query, *which* 1000 rows
survive is not even stable between reloads.

**Root cause:** Supabase project-level "Max Rows" cap (documented in `lib/data/client.ts`), not
applied consistently across the page.

**Recommended fix:** In `web/app/(ho)/sales/page.tsx`, wrap the queries at lines 204, 209, 214,
219, 852-859, 864 and 868 in `fetchAllRows(() => …)` exactly as line 558 already does. Run the
same check over `/stock-details` and `/footfall`, which are also row-level.

---

### A-05 — [P1] Ecomm "Cancelled" and "Cancel %" columns are always zero

**CONFIRMED** (prior report flagged this around line 876).

**Where:** `web/app/(ho)/sales/page.tsx:876-916`

**Proof (code):**

```
876    const byChannel = new Map<string, { orders: number; cancelled: number; units: number; net: number; mrp: number; discount: number }>();
877    for (const r of daily) {
878      const c = byChannel.get(r.channel) ?? { orders: 0, cancelled: 0, units: 0, net: 0, mrp: 0, discount: 0 };
879      c.orders += Number(r.total_orders);
880      c.units += Number(r.units);
881      c.net += num(r.net_selling_value);
882      c.mrp += num(r.gross_mrp_value);
883      c.discount += num(r.discount_value);
884      byChannel.set(r.channel, c);
885    }
...
910      cancelled: c.cancelled,
911      cancellationRate: c.orders > 0 ? (100 * c.cancelled) / c.orders : null,
```

`c.cancelled` is initialised to `0` (line 878) and never incremented — the whole file has four
mentions and none of them is an assignment:

```
$ grep -n "cancelled" "web/app/(ho)/sales/page.tsx"
876:  const byChannel = new Map<string, { orders: number; cancelled: number; ... }>();
878:    const c = byChannel.get(r.channel) ?? { orders: 0, cancelled: 0, ... };
910:    cancelled: c.cancelled,
911:    cancellationRate: c.orders > 0 ? (100 * c.cancelled) / c.orders : null,
```

The source row type has no cancelled field to read either (`page.tsx:113`):

```
113  type EcommDailyRow = { channel: string; order_date: string; total_orders: number; net_selling_value: number | string; gross_mrp_value: number | string; discount_value: number | string; units: number };
```

**Impact:** Wrong numbers presented as real ones. Every channel shows `0` cancelled and `0.0%`
cancel rate. The columns are sortable and filterable through `EcommChannelFacetedTable`, so a
user can "sort by worst cancel rate" or add an advanced condition on it and get a meaningless
result with no indication the column is unpopulated.

**Root cause:** `sales.vw_ecomm_daily` does not expose (or is not selecting) a cancelled-order
count.

**Recommended fix:** Add `cancelled_orders` to `sales.vw_ecomm_daily`, select it at
`page.tsx:209`/`:864`, and accumulate it at line 879. Until that view change lands, remove the
two columns from `EcommChannelRow`/`EcommChannelFacetedTable` rather than shipping constant
zeros.

---

### A-06 — [P2] Activating a "View by" combo on Sale-vs-Stock-Mix silently disables every filter

**Was prior finding F6 — CONFIRMED.**

**Where:** `web/app/(replenishment)/movement/SaleStockMixFacetedContent.tsx:59-62`, `:99-102`, `:212-235`

**Proof (code):**

```
 59    const [combo, setCombo] = useState<AttributeKey[]>([]);
 62    const [state, setState] = useState<FacetFilterState>(emptyFilterState);
...
 99    const attributeRows = useMemo(
100      () => aggregateMixByAttributes(itemRows, combo, totalSales, totalStock, mrpBucketSize),
101      [itemRows, combo, totalSales, totalStock, mrpBucketSize]
102    );
...
212      {combo.length === 0 ? (
213        <>
214          <FacetFilterBar
215            pageKey={PAGE_KEY}
...
226          <SaleStockMixGrid rows={gridRows} />
227        </>
228      ) : (
229        <>
230          <div className="mb-2 text-[12px] text-ink-3">
231            {attributeRows.length} {combo.map((a) => ATTRIBUTE_LABELS[a]).join(" + ").toLowerCase()} groups
232          </div>
233          <AttributeMixGrid rows={attributeRows} attributes={combo} />
234        </>
235      )}
```

`attributeRows` is computed from `itemRows` — the raw, **unfiltered** server rows — and never
consults `state`. Dropping one attribute chip into the box unmounts the entire FacetFilterBar,
taking with it the quick-search box, the Status facet, all advanced conditions, the group-by
levels, **and the chip row that would otherwise have shown them**.

**Impact:** A user who has narrowed to Status = "high priority" and then drags in "Color" is
looking at *all* style-colors bucketed by colour, not their subset — with no chip, count line,
or message saying so. Removing the chip restores the old filters, so the numbers appear to
change for no reason. The filter state is retained in React the whole time; this is a pure
unmount, not a reset, which is why nothing warns.

**Root cause:** The attribute grid was added as an either/or branch instead of as a second
rendering of the same filtered set.

**Recommended fix:** In `SaleStockMixFacetedContent.tsx`, hoist `<FacetFilterBar>` above the
ternary so it renders in both branches with a combo-appropriate `facets`/`advFields` set, and
feed `AttributeMixGrid` from `applyFacetFilter`-ed item rows. If that is too large, the minimum
acceptable fix is an explicit banner in the `combo.length > 0` branch stating that row filters
do not apply to the attribute view.

---

### A-07 — [P2] `/movement` "Recalculate" wipes the Sale-vs-Stock-Mix tab's filters; the fix exists as dead code

**Was prior finding F5 — CONFIRMED.**

**Where:** `web/app/(replenishment)/movement/page.tsx:165-189` (dead), `:290-310`, `:323-403`

**Proof (dead code):**

```
$ grep -n "buildHref" "web/app/(replenishment)/movement/page.tsx"
165:  function buildHref(overrides: Record<string, string | number>): string {
520:            state" principle as tabHref/buildHref elsewhere in this file. */}
```

The only two hits are the definition itself and a *comment* that references it. `buildHref` is
never called. Its body (lines 178-184) is exactly the missing preservation:

```
178        mix_store: searchParams.mix_store,
179        mix_style: searchParams.mix_style,
180        mix_color: searchParams.mix_color,
181        mix_period: searchParams.mix_period,
182        mix_status: searchParams.mix_status,
183        mix_page: searchParams.mix_page,
184        mix_perPage: searchParams.mix_perPage,
```

**Proof (the actual submit path):** both Replenishment-tab controls are plain GET `<form>`s, and
a native GET submit **replaces** the whole query string with only that form's own fields:

```
290        <form className="mt-3 flex flex-wrap items-end gap-4 text-[12.5px]">
291          <input type="hidden" name="tab" value="replenishment" />
292          <input type="hidden" name="wStockout" value={SCORE_W.stockoutRisk} />
293          <input type="hidden" name="wVelocity" value={SCORE_W.velocity} />
294          <input type="hidden" name="wCover" value={SCORE_W.cover} />
295          <input type="hidden" name="wRevenue" value={SCORE_W.salesValue} />
296          <input type="hidden" name="wTrend" value={SCORE_W.trend} />
297          <input type="hidden" name="wProductivity" value={SCORE_W.productivity} />
   (visible fields: targetCover, leadTime, safetyDays)
310          <Button type="submit">Recalculate</Button>
```

```
323        <form className="mt-3 grid grid-cols-1 gap-4 text-[12.5px] sm:grid-cols-2 lg:grid-cols-3">
324          <input type="hidden" name="tab" value="replenishment" />
325          <input type="hidden" name="targetCover" value={targetCoverDays} />
326          <input type="hidden" name="leadTime" value={leadTimeDays} />
327          <input type="hidden" name="safetyDays" value={safetyDays} />
   (visible fields: the six wXxx weights)
403            <Button type="submit">Recalculate priorities</Button>
```

Neither form contains a single `mix_*` hidden input. The **mix** tab's form does the reverse
correctly (`:517-529` carries all nine replenishment params back), so the loss is
one-directional.

**Impact:** `mix_store` and `mix_period` are real server params, read at
`page.tsx:465-467`:

```
465    const storeId = searchParams.mix_store ?? "";
466    const periodParam = Number(searchParams.mix_period) as SalesPeriodDays;
467    const salesPeriodDays: SalesPeriodDays = PERIOD_OPTIONS.includes(periodParam) ? periodParam : 30;
```

So pressing either "Recalculate" resets the Mix tab from (say) "Undri, last 90 days" back to
"All stores, last 30 days" with no indication. The tab bar (`tabHref`, lines 93-100) is
explicitly designed to preserve both tabs' state, so the forms break the page's own documented
contract (file header, lines 30-35).

**Root cause:** `buildHref` was written and then never wired to the forms.

**Recommended fix:** In `web/app/(replenishment)/movement/page.tsx`, add the `mix_*` hidden
inputs to both forms (after lines 291 and 324), mirroring lines 517-529. Then delete
`buildHref` (165-189), or instead convert the forms' submit buttons to
`<a href={buildHref({...})}>` links.

---

### A-08 — [P2] `?channels=` keeps filtering ECOM after the channel picker stops being rendered

**Was prior finding F4 — CONFIRMED, with one correction to the "silently" claim.**

**Where:** `web/app/(ho)/sales/page.tsx:1071-1076`, `:1146-1165`

**Proof (the control disappears):**

```
1146          locationSlot={
1147            showEbo ? (
1148              <MultiSelectFilter
1149                paramName="store"
...
1155            ) : showEcomm ? (
1156              <MultiSelectFilter
1157                paramName="channels"
...
1162            ) : (
1163              <span className="text-[12.5px] text-ink-3">— (select a vertical)</span>
1164            )
1165          }
```

`showEbo` wins the ternary, so whenever **both** verticals are in scope the channel picker is
not rendered at all — and both are in scope by default, since with no `?bu=`
`activeVerticals = [...grantedKeys]` (line 1037).

**Proof (the filter still applies):**

```
1071    const channelFilters = (searchParams.channels ?? "").split(",").filter(Boolean);
1072    const applyChannel: ApplyStore = (q, col = "channel") => {
1073      if (channelFilters.length === 0) return q;
1074      if (channelFilters.length === 1) return q.eq(col, channelFilters[0] as string);
1075      return q.in(col, channelFilters);
1076    };
```

`applyChannel` is passed unconditionally to `SharedCoreSection` (line 1175) and
`EcommDetailSection` (line 1254), and is applied to all four shared-core queries (lines 208,
218) and all three ecomm-detail queries (lines 852, 863, 867).

**Repro path:** select ECOM only → pick "Myntra" → URL becomes `?bu=ecomm&channels=Myntra` →
set the Vertical filter back to All → `bu` is dropped but `channels=Myntra` is preserved,
because `MultiSelectFilter.commit` copies the whole existing query string
(`StoreFilter.tsx:187`, `const params = new URLSearchParams(searchParams.toString());`) → the
picker is now gone and every ECOM number on the page is Myntra-only.

**Correction:** it is not fully *silent*. Two read-only indicators remain — the "Showing:" scope
line (built at 1125, rendered at 1135):

```
1125      showEcomm ? (channelFilters.length > 0 ? `${channelFilters.length} channel${…}` : "all channels") : null,
```

and the ECOM section-header chip:

```
1242            {channelFilters.length > 0 && (
1243              <span className="rounded-full bg-accent-soft px-2.5 py-0.5 …">
1244                {channelFilters.join(", ")}
```

Neither is removable — the chip has no `×` and is not a link — so there is **no in-app way to
clear the filter**. The user must hand-edit the URL, or switch to ECOM-only, clear, and switch
back.

**Impact:** The combined EBO+ECOM KPIs (Net sales, Gross MRP, Discount, Ecomm units) and the
whole ECOM section quietly report a single-channel subset while the filter bar offers only the
store picker.

**Recommended fix:** In `web/app/(ho)/sales/page.tsx`, render **both** pickers in `locationSlot`
when both verticals are active (the `ScopeBar` "Location" column renders whatever node it is
given — `ScopeBar.tsx:84-92`) instead of an either/or ternary. Minimum fix: make the chip at
1242-1246 a `<Link>` to the same URL minus `channels`.

---

### A-09 — [P2] Custom From/To inputs never re-sync; changing the main range leaves a stale comparison

**Was prior finding F3 — CONFIRMED, both halves.**

**Where:** `web/components/ui/DateRangePicker.tsx:37-38`, `:52-55`;
`web/components/ui/ComparisonDateRangePicker.tsx:50-51`

**Proof (no re-sync):**

```
DateRangePicker.tsx
 37    const [customFrom, setCustomFrom] = useState(from);
 38    const [customTo, setCustomTo] = useState(to);
```

```
ComparisonDateRangePicker.tsx
 50    const [customFrom, setCustomFrom] = useState(compareFrom ?? shiftDays(from, -rangeDays(from, to)));
 51    const [customTo, setCustomTo] = useState(compareTo ?? shiftDays(from, -1));
```

Neither file contains a `useEffect` keyed on `from`/`to`/`compareFrom`/`compareTo`; the only
`useEffect` in each is the click-outside listener (`DateRangePicker.tsx:44-50`,
`ComparisonDateRangePicker.tsx:57-63`). `router.push()` to the same route is a soft navigation:
React reconciles the same component instance, so the `useState` initialiser is never re-run.
The custom inputs therefore keep showing whatever range was current at first mount — surviving
preset clicks, browser Back, and hand-edited URLs.

**Proof (stale comparison):** `DateRangePicker.apply` copies the entire existing query string
and overwrites only `from`/`to`:

```
 53      const params = new URLSearchParams(searchParams.toString());
 54      params.set("from", newFrom);
 55      params.set("to", newTo);
```

`compareFrom`/`compareTo` survive untouched and are re-derived by nothing. The comparison
picker's own presets *are* derived from the current range
(`ComparisonDateRangePicker.tsx:78-80`), but only when clicked.

**Impact:** Set compare = "Previous period" while on August (→ July), then switch the main range
to Q2. The comparison button still reads the July window and the page compares Q2 against July —
a nonsense baseline that `DeltaBadge` presents as an ordinary percentage change.
`SharedCoreSection` faithfully applies whatever the params say (`sales/page.tsx:214`, `:219`),
so these are wrong numbers, not merely a wrong label.

**Recommended fix:** (a) add `useEffect(() => { setCustomFrom(from); setCustomTo(to); }, [from, to])`
to `DateRangePicker.tsx` and the equivalent to `ComparisonDateRangePicker.tsx`; (b) in
`DateRangePicker.apply`, when `compareFrom`/`compareTo` are present, either re-derive them from
the new range using the same `shiftDays` logic, or delete them and let the user re-pick. Either
beats silently keeping the old baseline.

---

### A-10 — [P2] Empty-value text condition matches every row but still shows an active chip; no "is blank" for text

**CONFIRMED** (prior P3 item; raised to P2 because the chip actively misinforms).

**Where:** `web/components/ui/FacetFilterBar.tsx:35-40`, `:113-115`, `:269-278`, `:330`

**Proof (no blank operator for text):**

```
 35  const TEXT_OPS = [
 36    { key: "contains", label: "contains" },
 37    { key: "not_contains", label: "does not contain" },
 38    { key: "eq", label: "is" },
 39    { key: "ne", label: "is not" },
 40  ] as const;
```

`blank` / `not_blank` exist only in `NUM_OPS` (lines 48-49).

**Proof (empty value is inert but still chipped):**

```
113      const a = String(raw ?? "").toLowerCase();
114      const b = String(c.value ?? "").toLowerCase();
115      if (!b) return true;
```

```
269    state.conditions.forEach((c, i) => {
270      if (!c.field) return;
...
274      activeChips.push({
275        label: `${f?.label ?? c.field} ${op?.label ?? c.op} ${c.value}`.trim(),
```

and the "Advanced" button is highlighted on `state.conditions.length > 0` alone (line 330).

**Impact:** The user sees a highlighted "Advanced (1)" button plus a chip reading
`Style No. contains` and reasonably concludes a filter is applied; nothing is. Separately,
there is no way to ask "which rows have no Color" — the most common reason to open an advanced
filter on a text column.

**Recommended fix:** In `web/components/ui/FacetFilterBar.tsx`: (a) add
`{ key: "blank", label: "is blank" }` and `{ key: "not_blank", label: "is not blank" }` to
`TEXT_OPS`, and handle them in the text branch of `rowMatchesConditions` (treat `null`, `""`
and whitespace-only as blank); (b) skip pushing a chip for an inert condition
(`!c.value && c.op !== "blank" && c.op !== "not_blank"`), or render it visibly greyed as
"incomplete".

---

### A-11 — [P3] "Select all" in a facet panel erases selections hidden by the facet search box

**CONFIRMED.**

**Where:** `web/components/ui/FacetFilterBar.tsx:552-556`, `:571`, `:215-217`

**Proof (code):**

```
552    let values = [...counts.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
553    if (search.trim()) {
554      const needle = search.trim().toLowerCase();
555      values = values.filter((v) => v.toLowerCase().includes(needle));
556    }
```

```
571        <button type="button" onClick={() => onSetAll(values)} className="text-accent hover:underline">
572          Select all
```

```
215    function setFacetValues(key: string, values: string[]) {
216      onChange({ ...state, facets: { ...state.facets, [key]: values } });
217    }
```

`onSetAll` receives the **search-filtered** `values`, and `setFacetValues` **replaces** the
stored array rather than unioning into it.

**Repro (trace):** tick "Red" → type `bl` in the facet search box → click "Select all" →
`state.facets[key]` becomes `["Black","Blue"]`. "Red" is gone, and because the search box is
still filled the user cannot see that it went.

**Recommended fix:** In `FacetPanel`'s "Select all" handler (`FacetFilterBar.tsx:571`), union
instead of replace:
`onSetAll([...new Set([...(state.facets[facet.key] ?? []), ...values])])`. Consider relabelling
to "Select all shown" while the search box is non-empty.

---

### A-12 — [P3] `channelHref` bakes the default date window permanently into the URL

**CONFIRMED.**

**Where:** `web/app/(ho)/sales/page.tsx:1043-1047`, `:1082-1096`

**Proof (code):**

```
1043    const today = new Date();
1044    const defaultFrom = new Date(today);
1045    defaultFrom.setDate(defaultFrom.getDate() - 29);
1046    const from = searchParams.from ?? isoDate(defaultFrom);
1047    const to = searchParams.to ?? isoDate(today);
...
1082    function channelHref(target: string | null) {
1083      const params = new URLSearchParams();
1084      if (searchParams.bu) params.set("bu", searchParams.bu);
1085      if (searchParams.store) params.set("store", searchParams.store);
1086      if (searchParams.channels) params.set("channels", searchParams.channels);
1087      if (from) params.set("from", from);
1088      if (to) params.set("to", to);
```

Lines 1084-1086 correctly forward only what was already in the URL; lines 1087-1088 use the
**resolved** values instead, so a page loaded with no date params emits an absolute window.

**Impact:** Clicking one channel row turns the URL into
`?from=2026-07-29&to=2026-08-27&channel=…`. That window is now frozen: bookmark or share the
link and it keeps showing late-July/August forever instead of the rolling last-30-days the user
believed they were on. Contrast `tabHref` on `/movement` (`page.tsx:93-100`), which forwards
only pre-existing params.

**Recommended fix:** In `channelHref`, use `searchParams.from` / `searchParams.to` at lines
1087-1088, matching the three lines immediately above.

---

### A-13 — [P3] Saved views on the `/sales` period table are keyed per calendar grain

**CONFIRMED.**

**Where:** `web/app/(ho)/sales/PeriodSalesFacetedTable.tsx:207`

**Proof:**

```
$ grep -rn "pageKey=" web/app --include=*.tsx
web/app/(admin)/users/UsersAdmin.tsx:168:          pageKey={PAGE_KEY}
web/app/(ho)/network/AgentSalesFacetedTable.tsx:63:        pageKey={PAGE_KEY}
web/app/(ho)/network/StoreDiagnosisFacetedTable.tsx:60:        pageKey={PAGE_KEY}
web/app/(ho)/network/StoreLeagueFacetedContent.tsx:50:      <FacetFilterBar pageKey={PAGE_KEY} …
web/app/(ho)/sales/EcommChannelFacetedTable.tsx:114:      <FacetFilterBar pageKey={PAGE_KEY} …
web/app/(ho)/sales/PeriodSalesFacetedTable.tsx:207:        pageKey={`${PAGE_KEY}_${grain}`}
web/app/(ho)/sales/ProductAttributeSalesTable.tsx:288:        pageKey={PAGE_KEY}
web/app/(replenishment)/movement/ReplenishmentFacetedContent.tsx:270:            pageKey={PAGE_KEY}
web/app/(replenishment)/movement/SaleStockMixFacetedContent.tsx:215:            pageKey={PAGE_KEY}
```

Only this one interpolates. `listMySavedViews` filters on `page_key` exactly
(`web/lib/savedViews/actions.ts:50`, `.eq("page_key", pageKey)`), so the "Saved views…"
dropdown empties whenever the user flips Daily → Weekly → Monthly.

**Impact:** Minor and arguably defensible (a grain change alters what the rows *are*), but the
behaviour is invisible: a view saved on Daily vanishes on Weekly and reappears on Daily, which
reads as data loss.

**Recommended fix:** Either drop the `_${grain}` suffix in `PeriodSalesFacetedTable.tsx:207` and
store the grain inside the saved state, or label the dropdown with the active grain so the
scoping is visible.

---

### A-14 — [P3] Empty-string facet values are unlistable but still excluded

**NEW.**

**Where:** `web/components/ui/FacetFilterBar.tsx:160-164` vs `:78-79`

**Proof (code):**

```
160    for (const r of base) {
161      const v = facet.get(r);
162      if (v === null || v === "") continue;
163      counts.set(v, (counts.get(v) ?? 0) + 1);
164    }
```

```
 78      const v = f.get(row);
 79      if (v === null || !sel.has(v)) return false;
```

A row whose facet value is `""` never appears as a checkbox option (line 162), but the moment
any value in that facet is ticked, line 79 drops it (`""` is not `null`, and `sel` can never
contain `""`).

**Impact:** Rows with a blank attribute are unreachable — there is no "(blank)" option to tick,
and any facet selection silently discards them, so visible row counts do not reconcile against
the unfiltered total. `buildGroupedRows` handles the same case correctly by contrast
(line 508: `const v = getter(row) || "(blank)";`), so the two halves of the component disagree.

**Recommended fix:** In `facetOptionCounts`, normalise `null` and `""` to a `"(blank)"`
sentinel, and match that sentinel symmetrically in `rowMatchesFacets` — mirroring
`buildGroupedRows`.

---

### A-15 — [P3] `revalidatePath("/movement")` is hard-coded in the saved-views actions

**NEW.**

**Where:** `web/lib/savedViews/actions.ts:72`, `:82`

**Proof:**

```
 72    revalidatePath("/movement");
 82    revalidatePath("/movement");
```

`FacetFilterBar` is mounted on `/sales`, `/network` and `/users` too — see the `pageKey=` grep
under A-13.

**Impact:** Low. The component refetches its own list client-side after save/delete
(`FacetFilterBar.tsx:244`), so nothing is visibly broken — but an unrelated route is
invalidated on every save, and the call does not achieve its intent for the other pages.

**Recommended fix:** Drop both `revalidatePath` calls (the client refetch already covers the
list), or accept the path as an argument.

---

### A-16 — [P3] `/movement` Mix "Apply" emits a dozen empty query params

**NEW.**

**Where:** `web/app/(replenishment)/movement/page.tsx:517-529`

**Proof:**

```
521        <input type="hidden" name="targetCover" value={searchParams.targetCover ?? ""} />
522        <input type="hidden" name="leadTime" value={searchParams.leadTime ?? ""} />
523        <input type="hidden" name="safetyDays" value={searchParams.safetyDays ?? ""} />
   … wStockout, wVelocity, wCover, wRevenue, wTrend, wProductivity, same pattern …
```

A native GET submit serialises empty-valued fields, so pressing "Apply" on a freshly loaded
page produces `?tab=mix&targetCover=&leadTime=&safetyDays=&wStockout=&…&mix_store=&mix_period=30`.

**Impact:** Cosmetic. The reader guards are numeric and reject the empty strings
(`page.tsx:133-138`: `Number(searchParams.targetCover) > 0`, and `nonNegNum`), and `tabHref`
(line 96, `if (v)`) strips them again on the next tab click. But the URL becomes noisy and hard
to reason about, which matters for a page whose whole design premise is URL-addressable state.

**Recommended fix:** Render each hidden input conditionally, e.g.
`{searchParams.targetCover ? <input type="hidden" name="targetCover" value={searchParams.targetCover} /> : null}`.

---

### A-17 — [P3] Five `mix_*` URL params are forwarded but read by nothing; Mix-tab filters are not URL state at all

**NEW.**

**Where:** `web/app/(replenishment)/movement/page.tsx:83-88`, `:179-184`

**Proof:**

```
$ grep -rn "mix_style\|mix_color\|mix_status\|mix_page\|mix_perPage" web/app web/lib
web/app/(replenishment)/movement/page.tsx:83:  mix_style?: string;
web/app/(replenishment)/movement/page.tsx:84:  mix_color?: string;
web/app/(replenishment)/movement/page.tsx:86:  mix_status?: string;
web/app/(replenishment)/movement/page.tsx:87:  mix_page?: string;
web/app/(replenishment)/movement/page.tsx:88:  mix_perPage?: string;
web/app/(replenishment)/movement/page.tsx:179:      mix_style: searchParams.mix_style,
web/app/(replenishment)/movement/page.tsx:180:      mix_color: searchParams.mix_color,
web/app/(replenishment)/movement/page.tsx:182:      mix_status: searchParams.mix_status,
web/app/(replenishment)/movement/page.tsx:183:      mix_page: searchParams.mix_page,
web/app/(replenishment)/movement/page.tsx:184:      mix_perPage: searchParams.mix_perPage,
```

Lines 179-184 are inside the dead `buildHref` (A-07). There is no read site anywhere else.
Style/Color/Status filtering and pagination moved client-side into `SaleStockMixFacetedContent`
(documented at `page.tsx:455-464`), which keeps its state in React and never touches the URL.

**Impact:** An old bookmark `?tab=mix&mix_status=overstocked` now shows *everything* while
looking as though a filter applied. This is the benign direction of the failure — a dead param,
not a hidden one. The more consequential half is the corollary: the Mix tab's (and
Replenishment tab's) facet/search/group-by/pagination state is **not URL-addressable at all**,
so it is lost on every navigation and cannot be shared with a colleague. That is the inverse of
the round-trip property the rest of the page maintains, and it is worth an explicit product
decision rather than an accident.

**Recommended fix:** Delete lines 83-88 (and the matching `buildHref` entries when that goes,
per A-07). If URL-addressable mix filters are wanted, that is a feature request on
`SaleStockMixFacetedContent` / `FacetFilterBar` — serialise `FacetFilterState` to a single
compact search param.

---

### A-18 — [P3] "Clear all" also clears Group-by, which has no chip in that row

**NEW.**

**Where:** `web/components/ui/FacetFilterBar.tsx:218-220`, `:260-278`, `:357-368`, `:461-475`

**Proof:**

```
218    function clearAll() {
219      onChange(emptyFilterState());
220    }
```

`emptyFilterState()` (line 61) returns `{ search: "", facets: {}, conditions: [], groupBy: [] }`.
The chip row hosting the "Clear all" button (lines 461-475) is built from `activeChips`, which
contains facets, search and conditions only (lines 260-278) — group-by levels are rendered in a
different row entirely (lines 357-368).

**Impact:** Minor. Clicking "Clear all" beneath the chips also collapses a two- or three-level
grouping the user set up elsewhere on the bar, with no chip in that row to warn them.

**Recommended fix:** Either preserve grouping —
`onChange({ ...emptyFilterState(), groupBy: state.groupBy })` — or relabel the button
"Reset filters & grouping".

---

### A-19 — [P3] Ecomm "Top styles": Units counts cancelled lines, Net excludes them

**NEW.**

**Where:** `web/app/(ho)/sales/page.tsx:888-898`

**Proof:**

```
889    for (const l of lines) {
890      const key = (l.style && l.style.trim()) || l.item_sku || "Unknown SKU";
891      const s = bySku.get(key) ?? { key, units: 0, net: 0, mrp: 0, discount: 0 };
892      s.units += 1;
893      if (l.status !== "CANCELLED") s.net += num(l.selling_price);
894      s.mrp += num(l.mrp);
895      s.discount += num(l.discount);
```

Line 892 is unconditional; line 893 is guarded on the same row's status.

**Impact:** In "Top styles — ECOM", a style with many cancellations shows inflated Units against
correct Net revenue, so the implied per-unit price is wrong. Combined with A-04 (this same query
is unpaginated and unordered) this table should not be trusted at all today.

**Recommended fix:** Guard line 892 the same way — `if (l.status !== "CANCELLED") s.units += 1;`
— or add a separate "Cancelled units" column so both figures are visible.

---

### A-20 — WITHDRAWN

An earlier draft of this report claimed `/footfall` re-emitted its resolved date defaults
through a GET form. **That is wrong** — I checked and it does not. `/footfall` mounts the same
client components as everywhere else (`footfall/page.tsx:96`
`<StoreFilter … allowAll={false} />`, `:98` `<DateRangePicker from={from} to={to} />`), both of
which `router.push()` only params the user actually chose. Its store handling is in fact
exemplary (`footfall/page.tsx:37-39`):

```
 37    const requested = searchParams.store;
 38    const storeId =
 39      requested && user.storeIds.includes(requested) ? requested : (user.storeIds[0] as string);
```

— a hand-typed `?store=` is validated against the caller's own stores and falls back
gracefully. `/footfall`'s only real defect is inherited: **A-01**, via `DateRangePicker`.

The ID is kept as a withdrawn placeholder so the numbering stays stable.

---

### A-21 — [P3] `/targets` treats an absent param as "apply a default filter"

**NEW.**

**Where:** `web/app/(ho)/targets/page.tsx:105-106`

**Proof:**

```
100    function parseMulti(raw: string | undefined, valid: string[], defaultValue: string): string[] {
101      if (raw === undefined) return valid.includes(defaultValue) ? [defaultValue] : [];
102      if (raw === "") return [];
103      return raw.split(",").filter((v) => valid.includes(v));
104    }
105    const genders = parseMulti(searchParams.gender, genderList, "FEMALE");
106    const categories = parseMulti(searchParams.category, categoryList, "APPAREL");
```

`parseMulti`'s third argument is a **fallback selection**, not an "all" sentinel — which is
exactly why `MultiSelectFilter` grew its `clearAsEmptyParam` escape hatch, documented at
`web/components/ui/StoreFilter.tsx:160-167`:

```
160    /**
161     * When true, clearing every checkbox writes `?param=` (present, empty)
162     * instead of deleting the param outright. Needed wherever the page treats
163     * an ABSENT param as "apply a default filter" (see /targets' Gender and
164     * Category) — without this, clicking "Clear" would just fall back to the
165     * default again instead of actually showing everything.
166     */
```

**Impact:** A bare `/targets` URL — the nav link, or a link pasted to a colleague — is silently
pre-filtered to FEMALE + APPAREL. Mitigating factors, all verified: the behaviour is
**deliberate and documented** (`targets/page.tsx:96-99`), `parseMulti` validates every value
against the fetched option list (line 103), the pickers pass `clearAsEmptyParam`
(lines 174, 182) so "Clear" genuinely clears, and the chips show the active selection. So this
is a P3 convention wrinkle, not a hidden filter.

The residual risk is that "no param" meaning "filtered" inverts the convention every other page
uses (`StoreFilter.tsx:76-78`: "an unset filter never appears as a real value in the URL"), and
that `?gender=` and a missing `gender` mean different things — a footgun for anyone
hand-editing a URL or writing a link.

**Recommended fix:** Make the default explicit on first render by redirecting a bare `/targets`
to `/targets?gender=FEMALE&category=APPAREL`, so the URL always states the truth. Low priority.

---

### A-22 — [P3] `/stock-details` accepts unvalidated store ids in `?store=`

**NEW.**

**Where:** `web/app/(stock-details)/stock-details/page.tsx:322-326`

**Proof:**

```
322    const selectedStoreIds = (searchParams.store ?? "")
323      .split(",")
324      .map((s) => s.trim())
325      .filter(Boolean);
```

No membership check against the fetched store list — compare `/targets`, which does validate
(`targets/page.tsx:380-382`: `searchParams.store && storeList.some((s) => s.store_id === searchParams.store)`).

**Impact:** Low, and **not** a security issue — RLS/`fn_user_store_ids()` still bounds what the
query can return (`StoreFilter.tsx:8-15`). But a typo'd or stale store id produces an empty
result with an active-looking chip and no "unknown store" message.

**Recommended fix:** Filter `selectedStoreIds` against the known store list before use, matching
`/targets`.

---

## Prior findings — verdicts

| Prior | Verdict | Where verified |
|---|---|---|
| **F1** — `DateRangePicker` local-midnight + `toISOString()`; `ComparisonDateRangePicker` correct | **CONFIRMED**, both halves, with executed date math | A-01. File path is `web/components/ui/DateRangePicker.tsx` (the picker sits under `components/ui/`, not under a page folder); the bug is at line 8, not "around line 8" — `iso` is line 8 exactly. |
| **F2** — positional `attr0` facet key → empty table + `Gender: SS2026` | **CONFIRMED** | A-02 |
| **F3** — custom From/To don't re-sync; stale comparison after changing the main range | **CONFIRMED**, both halves | A-09 |
| **F4** — channel UI disappears when EBO+ECOM both active, `channels` keeps filtering | **CONFIRMED** on the mechanism; **partially refuted** on "no indication" — a non-removable chip and the "Showing:" line both surface it, but there is no way to clear it in-app | A-08 |
| **F5** — `/movement` "Recalculate" wipes Mix filters; `buildHref` is dead code | **CONFIRMED** | A-07 |
| **F6** — "view by" combo silently discards facet filters | **CONFIRMED** for `/movement` Sale-vs-Stock-Mix. **Does not apply** to `/sales`' ProductAttributeSalesTable, which keeps the FacetFilterBar mounted across combo changes — that component has the *opposite* failure (A-02) | A-06, A-02 |
| **P3** — "Select all" + facet search erases prior selection | **CONFIRMED** | A-11 |
| **P3** — text fields have no "is blank"; empty-value condition matches every row while showing an active chip | **CONFIRMED** | A-10 |
| **P3** — `channelHref` bakes the default date window into the URL | **CONFIRMED** | A-12 |
| **P3** — saved views keyed per-grain | **CONFIRMED** (`PeriodSalesFacetedTable.tsx:207` only; every other caller passes a bare constant) | A-13 |
| **"not a bug"** — `channelHref` does not drop params | **CONFIRMED not a bug.** `sales/page.tsx:1082-1096` re-emits every param the page's own `searchParams` type declares (`bu`, `store`, `channels`, `from`, `to`, `compareFrom`, `compareTo`) plus the new `channel`. Nothing in the declared set is lost. The separate `from`/`to` issue is A-12, which is about *value*, not omission. |
| **"not a bug"** — numeric "is blank" does not treat 0 as blank | **CONFIRMED not a bug.** `FacetFilterBar.tsx:91`: `if (c.op === "blank") return raw === null;` — a strict `=== null`, so `0` is correctly not blank, and line 92 `not_blank` is its exact complement. |
| **Also** — `sales/page.tsx:876`, `c.cancelled` never incremented | **CONFIRMED** | A-05 |

---

## VERIFIED CORRECT

Checked and found sound — worth knowing what is covered:

1. **`ComparisonDateRangePicker` date arithmetic** — `shiftDays`/`shiftYears`/`rangeDays`
   (`ComparisonDateRangePicker.tsx:20-35`) anchor every `Date` at `T00:00:00Z` and mutate with
   `setUTC*`, so they are timezone-independent. Verified by reading; no local-field access
   anywhere in the file.
2. **Comparison is half-open-safe** — `sales/page.tsx:1053-1055` requires *both*
   `compareFrom` and `compareTo` before either is used, so a hand-edited half-range cannot
   produce a delta against a window the user did not ask for.
3. **Comparison queries carry the same filters as the main queries** —
   `sales/page.tsx:212-221` applies `applyStore` / `applyChannel` to the comparison-period
   fetches identically to lines 202-211. The baseline is scoped the same way as the current
   period.
4. **Comparison queries are conditional** — `showEbo && comparing` / `showEcomm && comparing`
   (lines 212, 217); with no comparison set the section issues exactly the two queries it always
   did.
5. **`MultiSelectFilter` draft/commit semantics** — `StoreFilter.tsx:179-210`. Checkbox clicks
   mutate a local `pending` draft only; `openDropdown` re-seeds it from the committed `selected`
   (line 201), and `closeAndCommit` diffs before navigating (lines 207-209), so re-opening and
   closing without changes issues no navigation. Escape and outside-click both commit
   (lines 214-219).
6. **`MultiSelectFilter` preserves unrelated params** — `commit` starts from
   `new URLSearchParams(searchParams.toString())` (line 187), so activating one filter never
   discards another's param.
7. **`clearAsEmptyParam`** — `StoreFilter.tsx:188-191` correctly distinguishes "delete the param"
   from "set it empty", which is what makes `/targets`' Clear button actually clear (see A-21).
8. **`push()`-without-`refresh()` navigation contract** — `StoreFilter.tsx:36-48`,
   `DateRangePicker.tsx:56-69`. Every filter change produces a new query string, hence a Router
   Cache miss, hence a fresh fetch. The pairing bug they document (refresh() racing push() and
   reverting the URL) is genuinely avoided in all three components.
9. **Cascading facet counts** — `rowsExcludingFacet` / `facetOptionCounts`
   (`FacetFilterBar.tsx:138-168`) exclude the facet's *own* key when computing its option list,
   which is the correct Excel-style behaviour: a facet never hides its own current picks, and
   currently-selected values stay listed at count 0 (line 167) so they can always be removed.
10. **Advanced conditions degrade safely across a shape change** — `FacetFilterBar.tsx:87-88`,
    `if (!f) return true;`. A saved view built on a wider `advFields` set does not filter
    everything away on a narrower one. (This is exactly the guarantee A-02's facet path lacks.)
11. **Numeric `blank`/`not_blank`** — strict `=== null` / `!== null` (lines 91-92), so `0` is not
    treated as blank.
12. **`buildGroupedRows` blank handling** — `line 508`, `getter(row) || "(blank)"`, and stable
    `localeCompare(..., { numeric: true })` ordering (line 512).
13. **`tabHref` on `/movement`** — `page.tsx:93-100` copies every present param and changes only
    `tab`, so switching tabs genuinely preserves both tabs' server state. (It is the two GET
    forms that break this, not the tab links — A-07.)
14. **Mix tab's form preserves the Replenishment tab's params** — `page.tsx:517-529`, the correct
    direction of A-07.
15. **`/movement` tab gating is filter-aware** — `page.tsx:566`, `:572-577`: a request for a tab the user
    cannot see falls back to the other tab rather than rendering an empty page, and the denied
    tab is not offered as a link.
16. **`mix_period` is validated against an allow-list** — `page.tsx:466-467`,
    `PERIOD_OPTIONS.includes(periodParam) ? periodParam : 30`, so `?mix_period=99999` cannot
    reach the query.
17. **Replenishment what-if params are validated** — `page.tsx:133-147`: `> 0` / `>= 0` guards
    plus `nonNegNum`'s `Number.isFinite` check, so garbage values fall back to documented
    defaults rather than producing `NaN` scores.
18. **`/targets` validates `store` and `month`** — `targets/page.tsx:380-383`: store must exist in
    `storeList`; month must match `/^\d{4}-\d{2}$/`.
19. **Vertical scope cannot be widened via the URL** — `sales/page.tsx:1034-1037` intersects
    `?bu=` against `grantedKeys` (granted **and** pipeline-connected), so `?bu=mbo` on a user
    without MBO yields an empty vertical set, not access.
20. **`ScopeBar` never offers a vertical the user lacks** — `ScopeBar.tsx:46-47`; a granted but
    pipeline-less vertical renders as a static disabled chip with a tooltip, never as a
    selectable option.
21. **Store filter cannot widen access** — `StoreFilter.tsx:8-15`: the underlying views filter by
    `core.fn_user_store_ids()` regardless, so the picker only ever narrows within what the caller
    may already see.
22. **`/network` and `/ecomm` redirect stubs run their access gate first** —
    `network/page.tsx:22`, `ecomm/page.tsx:22` both `await requirePageAccess(...)` before
    `redirect()`, so an old bookmark cannot be used to reach `/sales`' broader role gate.
23. **`/ecomm` forces `bu=ecomm` on the redirect target** (`ecomm/page.tsx:24`), so an ecomm
    bookmark keeps showing ecomm rather than silently widening to "all granted verticals".
24. **`/sales` scope summary is derived, not hard-coded** — `page.tsx:1121-1127` restates the
    live vertical/date/store/channel/comparison scope in prose, which is a genuinely good
    mitigation for the whole class of "which numbers am I looking at" bugs.

---

## UNVERIFIED

Items I suspect but could not settle statically. Each lists the exact check needed.

- **U-1 — Does A-04's 1000-row truncation actually bite at production volumes?**
  I proved the queries are unpaginated and that the cap exists and is documented, but I did not
  run against the live database. **Check:** with the app running, open `/sales` with
  `?from=…&to=…` spanning 90 days and compare the KPI "Net sales" against
  `select sum(net_selling_value) from sales.vw_ecomm_daily where order_date between …`, and
  separately `select count(*) from sales.vw_ecomm_order_lines where order_date between …` — if
  that count exceeds 1000 the truncation is live.

- **U-2 — Does `/sales` render at all with zero active verticals?**
  `page.tsx:1037` can produce `activeVerticals = []` (e.g. `?bu=mbo` for a user without MBO).
  `SharedCoreSection` has an explicit `!showEbo && !showEcomm` KPI placeholder (line 267), which
  suggests it was designed for. **Check:** load `/sales?bu=nonexistent` and confirm the page
  renders the "No vertical selected" state rather than throwing.

- **U-3 — Whether `sales.vw_ecomm_daily` exposes a cancelled-order column at all.**
  A-05's fix depends on it. **Check:** `select * from sales.vw_ecomm_daily limit 1;` or read the
  view's migration.

- **U-4 — Whether AG Grid column sort survives a facet change on the faceted tables.**
  `buildGroupedRows`' own doc comment (`FacetFilterBar.tsx:488-491`) warns that grouping and
  column sort "are best used one at a time"; I did not determine whether a sort is silently
  dropped when `state` changes and the row array is rebuilt. **Check:** in `/movement`
  Replenishment, sort by a column, then tick a Status facet value, and observe whether the sort
  indicator and ordering persist.

- **U-5 — Saved views loaded across a schema change.**
  `handleLoadView` (`FacetFilterBar.tsx:249-252`) casts stored JSON straight to
  `FacetFilterState` with no validation. Given A-02, a view saved with `{facets:{attr0:[…]}}`
  will mis-apply on a different combo. **Check:** save a view on `/sales` product attributes with
  a Season facet value, change the combo, reload the view, and confirm the resulting chip.

- **U-6 — Are the four "no filters" admin pages genuinely filter-free at runtime?**
  `/integrations`, `/configurations`, `/data-upload` and `/users` read no `searchParams` (proved
  by grep), and I read `UsersAdmin.tsx`'s `advFields`. What I did **not** do is render them.
  **Check:** open each and confirm no client-side control writes to the URL — in particular
  whether `/data-upload`'s file list has an undocumented sort or status filter I would have
  missed by reading only for `searchParams`.

---

## Coverage table — page by page

| # | Page | Filters present | Checked | Result |
|---|------|-----------------|---------|--------|
| 1 | `app/(admin)/integrations/page.tsx` (63 ln) | **None** | `grep -n searchParams` → no hits | No filter mechanism, no URL state. Nothing to audit. |
| 2 | `app/(admin)/users/page.tsx` (195 ln) | None at the page level; `UsersAdmin.tsx:168` mounts a `FacetFilterBar` | `grep -n searchParams` → no hits; read `UsersAdmin.tsx:114-128` | Page reads no URL params. `advFields[0]` is `fullName` (text, `:116`), so A-03's "+ Add condition" path does **not** fire here; its field-switch path still does (`overrideCount` is numeric, `:119`). Also inherits A-10, A-11, A-14, A-18. Filter state is client-only, not URL-addressable. |
| 3 | `app/(configurations)/configurations/page.tsx` (111 ln) | **None** | `grep -n searchParams` → no hits | Nothing to audit. |
| 4 | `app/(data-upload)/data-upload/page.tsx` (144 ln) | **None** | `grep -n searchParams` → no hits | Nothing to audit. |
| 5 | `app/(ebo)/footfall/page.tsx` (169 ln) | `store`, `from`, `to` | Read lines 14-70 + the filter row (`:96`, `:98`) | `?store=` validated against `user.storeIds` with a graceful fallback (:37-39) — **correct**. Dates default at :49-50. Mounts `DateRangePicker` (:98) → **A-01 applies**; that is the page's only defect. A-20 was drafted here and then withdrawn. No comparison picker, no facets, no pagination. |
| 6 | `app/(ebo)/my-store/page.tsx` (54 ln) | **None** | Full read | Single-store scaffold; store comes from `user.storeIds[0]` (:16), not the URL. `.limit(1).maybeSingle()` on an ordered query — correct, no pagination concern. |
| 7 | `app/(ecomm)/ecomm/page.tsx` (29 ln) | Redirect stub | Full read | Forwards `from`/`to`/`channel` and forces `bu=ecomm` (:24). Gate runs before redirect (:22). Does **not** forward `channels`, `compareFrom`, `compareTo` — none were ever params of this route, so no loss. **Correct.** |
| 8 | `app/(ho)/network/page.tsx` (30 ln) | Redirect stub | Full read | Forwards `bu`/`store`/`from`/`to`; gate first (:22). **Correct.** |
| 9 | `app/(ho)/sales/page.tsx` (1267 ln) | `from`, `to`, `compareFrom`, `compareTo`, `store`, `bu`, `channel`, `channels` + 4 client-side `FacetFilterBar`s | Full read of the filter paths (1022-1267), `SharedCoreSection` (174-292), `EcommDetailSection` (833-960), `ProductAttributeSalesTable`, `PeriodSalesFacetedTable` pageKey | **A-02, A-04, A-05, A-08, A-12, A-13, A-19** + A-01/A-09 via the shared pickers. Verified-correct items 2, 3, 4, 19, 24. |
| 10 | `app/(ho)/targets/page.tsx` (430 ln) | `gender`, `category` (multi), `store`, `month` | `grep -n searchParams` + lines 105-106, 380-383 | **A-21** (absent param = default filter). `store` and `month` are validated (verified-correct 18). Uses `clearAsEmptyParam` correctly (verified-correct 7). |
| 11 | `app/(marketing)/campaigns/page.tsx` (41 ln) | **None** | Full read | Placeholder list, one unfiltered `.order()` query. No filters, no URL state. |
| 12 | `app/(replenishment)/movement/page.tsx` (648 ln) | `tab`, 10 replenishment params, 7 `mix_*` params + 2 client-side `FacetFilterBar`s | Full read | **A-07, A-16, A-17** + A-06 via `SaleStockMixFacetedContent`. Verified-correct items 13, 14, 15, 16, 17. |
| 13 | `app/(replenishment)/replenishment/page.tsx` (9 ln) | Redirect stub | Full read | Redirects to `/movement?tab=replenishment` dropping all filter state — explicitly documented as acceptable (:5-6). Note it does **not** run a page-access gate, unlike the `/network` and `/ecomm` stubs; `/movement` gates on arrival (`page.tsx:566`, `await requirePageAccess("replenishment")`), so this is not an access hole, just an inconsistency. |
| 14 | `app/(replenishment)/sale-stock-mix/page.tsx` (9 ln) | Redirect stub | Full read | Same as #13, to `?tab=mix`. Old `?store=`/`?period=` bookmarks lose their filters. Documented. |
| 15 | `app/(stock-details)/stock-details/page.tsx` (450 ln) | `store` (comma-separated multi) | `grep -n searchParams` + lines 285-326 | **A-22** (no validation against the store list). Only one URL param; no dates, no facets. |
| 16 | `app/(workspace)/workspace/page.tsx` (301 ln) | `workspaceId` only | `grep -n searchParams` + lines 42-60 | Not a filter — a record selector, passed straight to `getWorkspaceById`. Access is re-checked per component via `requires_page_key` (:130-132). Nothing to audit as a filter. |
| 17 | `app/login/page.tsx` (62 ln) | `next`, `error`, `email` | Full read | Not filters. Note `searchParams.error` is `decodeURIComponent`'d and rendered (:24) — reflected text, but React escapes it, so not an injection. `next` (:29) is forwarded into a hidden input; open-redirect safety is the sign-in action's business, out of scope for this audit and flagged for Agent covering auth. |
| 18 | `app/page.tsx` (33 ln) | **None** | Full read | Pure role-based redirect. |
| 19 | `app/sh-test/page.tsx` (48 ln) | **None** | Full read | Isolated PostgREST proving ground, not linked from nav. Two hard-coded queries, no filters. |

### Shared components covered

| File | Covered |
|---|---|
| `web/components/ui/DateRangePicker.tsx` (144 ln) | Full read — A-01, A-09 |
| `web/components/ui/ComparisonDateRangePicker.tsx` (159 ln) | Full read — verified correct (A-01 counterpart), A-09 |
| `web/components/ui/ScopeBar.tsx` (104 ln) | Full read — verified correct (item 20) |
| `web/components/ui/StoreFilter.tsx` (283 ln) — `StoreFilter`, `AttributeFilter`, `MultiSelectFilter` | Full read — verified correct (items 5-8, 21) |
| `web/components/ui/FacetFilterBar.tsx` (598 ln) | Full read — A-03, A-10, A-11, A-14, A-18; verified correct (items 9-12) |
| `web/lib/savedViews/actions.ts` (83 ln) | Full read — A-15 |
| `web/lib/data/client.ts` | Read the `QueryChain` / `fetchAllRows` contract — A-04 |
| `web/lib/sales/attributeBreakdown.ts` | Read the constants feeding A-02 |
| `web/app/(ho)/sales/ProductAttributeSalesTable.tsx` (317 ln) | Full read — A-02 |
| `web/app/(replenishment)/movement/SaleStockMixFacetedContent.tsx` (238 ln) | Full read — A-06 |

---

## Suggested fix order

1. **A-01** — one line, fixes wrong date windows on every page. Highest value per unit of risk.
2. **A-05** — remove or populate the two fake columns.
3. **A-03** — one guard line in `rowMatchesConditions`.
4. **A-02** — one-line key change in `ProductAttributeSalesTable.tsx`.
5. **A-07** — add the `mix_*` hidden inputs, delete `buildHref`.
6. **A-04** — mechanical `fetchAllRows` wrapping, but touches seven query sites; verify against
   U-1 first so the change is provably needed and provably sufficient.
7. **A-09, A-08, A-06** — real UX/correctness work, each needs a small design decision.
8. The P3s as cleanup.
