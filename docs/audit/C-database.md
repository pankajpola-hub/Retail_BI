# Audit C — Database, Schema & Numeric Correctness

- **Date**: 2026-08-27
- **Repo**: `D:\Py\Sales & Marketing dashboard_Test`, branch `master`
- **Commit audited**: `014b1c533ae877002bf92a8204efa7590d8ad299` ("Fix RETURN sign convention — Sales/Targets were ~8% too high")
- **DB connection**: **CONNECTED** (read-only SELECTs only, no DDL/DML executed).
  Supabase project `naukfqwjunorzntnzkok` via session pooler
  `aws-0-ap-southeast-1.pooler.supabase.com:5432`, user `postgres.naukfqwjunorzntnzkok`.
  *(Connection note for future runs: the password in `SUPABASE_DB_URL` is **percent-encoded**.
  It must be URL-decoded before being put in `PGPASSWORD`; passing the encoded form, or
  decoding with bash `printf %b`, both fail auth. `python -c "urllib.parse.unquote(...)"` works.)*
- **Migrations reviewed**: `0082`–`0093` in full, plus targeted reads of the whole
  `server/db/migrations/` tree (0000–0093, 94 files). Live view definitions were dumped from
  `pg_get_viewdef()` and compared against the migration source.

> **NOTE ON SCOPE**: this file is written incrementally. Sections below are appended as
> evidence is gathered.

---

## HEADLINE ANSWER — why Sales value AND quantity don't match the ERP

Three independent, **proven** defects are inflating/deflating the numbers right now. In
order of magnitude:

1. **C-01 (P0)** — migration `0093` has **not been run**. All **227** sync-written RETURN
   rows still carry a **positive** sign on **all three** fields. The reporting chain *adds*
   them instead of subtracting, so every FY26-27 number is overstated by **exactly 2x the
   returns**: **+454 units** and **+Rs 5,58,398** network-wide. This is the dominant cause.
2. **C-02 (P1)** — `BO-004 Lucknow` is `is_active = false` in `core.stores`, and
   `sales.vw_ebo_sales_lines` **inner-joins** on `is_active`. **1,631 rows / Rs 25,11,213 /
   1,524 units** of real ERP data are therefore invisible to every dashboard view, while
   `vw_sale_transactions_export` (a LEFT JOIN) still shows them. Dashboard and export
   disagree with each other and with an ERP report that includes the branch.
3. **C-03 (P2)** — the Excel-upload path and the nightly sync assign `line_seq`
   independently, so the same physical bill line can be stored twice under different
   `line_seq` values. Proven live on bill `2627/3/SB-000343`.

Full proof for each is in the Findings section.

---

## PART 1 — SIGN CONVENTION (value AND quantity): full trace, end to end

### The canonical convention

`raw_logic.sales_transactions` stores **SIGNED** amounts and quantities: a RETURN row is
negative on `total_quantity`, `gross_amount` and `net_amount`. Every downstream SQL view
sums the stored value **as-is** with no sign logic of its own, so the sign must be carried
in the data.

### Full trace table

| # | Step | File:line | Sign handling — **value** | Sign handling — **qty** | Correct? |
|---|------|-----------|---------------------------|--------------------------|----------|
| 1 | ERP source view `sale_detail` | external Supabase project (`SALES_SUPABASE_URL`) | emits `signed_net_amount` / `signed_gross_amount` **already negative** for returns | emits `signed_quantity` **already negative** | source of truth |
| 2 | Sync route selects the signed columns | `web/app/api/cron/sale-detail-sync/route.ts:137` — `.select("… signed_net_amount, signed_gross_amount, signed_quantity …")` | picks the signed column, not the unsigned one | picks `signed_quantity` | OK |
| 3 | Sync route normalises | `web/app/api/cron/sale-detail-sync/route.ts:87-90` — `function toSigned(v) { const n = … Number(v); return Number.isFinite(n) ? n : 0; }` | **pass-through, no `Math.abs()`** (was `toUnsigned()` before `014b1c5`) | same function, same pass-through | OK (fixed in `014b1c5`) |
| 4 | Sync route builds payload | `route.ts:163-165` — `total_quantity: toSigned(r.signed_quantity), gross_amount: toSigned(r.signed_gross_amount), net_amount: toSigned(r.signed_net_amount)` | signed | signed | OK — all three fields treated identically |
| 5 | Upsert into raw table | `ops.fn_upsert_synced_sale_rows` (live `pg_get_functiondef`; source `server/db/migrations/0090_sale_detail_sync.sql`) — `select … total_quantity, gross_amount, net_amount … from parsed` / `do update set total_quantity = excluded.total_quantity, …` | verbatim pass-through, no sign logic | verbatim pass-through | OK |
| 6 | Excel upload path | `ops.fn_process_sale_upload` / `web/lib/erpReports/parseSaleWorkbook.ts` | stores the workbook's own sign — negative for `RB-` bills (proven: 0 of 984 Excel return rows are positive) | same | OK |
| 7 | Raw table | `raw_logic.sales_transactions` (`numeric` on all three) | **CURRENTLY BROKEN — see C-01**: 227 sync-written RETURN rows are POSITIVE | **also positive** — qty is broken in exactly the same way as value | BROKEN |
| 8 | `sales.vw_ebo_sales_lines` | live viewdef — `st.total_quantity`, `st.gross_amount`, `COALESCE(st.net_amount, st.gross_amount) AS net_amount` | **no sign logic** — reads as stored | **no sign logic** | OK (assumes step 7 correct) |
| 9 | `sales.vw_ebo_bill` | live viewdef — `sum(total_quantity) AS quantity, sum(gross_amount), sum(net_amount)` grouped by bill | plain `SUM`, no sign | plain `SUM`, no sign | OK |
| 10 | `sales.vw_ebo_sales_daily` | live viewdef — `sum(vw_ebo_bill.net_amount) AS net_sales`, `sum(quantity) AS net_quantity`, plus `… FILTER (WHERE bill_type = 'RETURN')` | plain `SUM`, no sign | plain `SUM`, no sign | OK |
| 11 | `sales.vw_ebo_sales_weekly` / `_monthly` | live viewdef — `sum(net_sales)`, `sum(net_quantity)` over `_daily` | plain `SUM` | plain `SUM` | OK |
| 12 | `sales.vw_ebo_sale_attribute_lines` (0092) | live viewdef — `st.total_quantity, st.gross_amount, COALESCE(st.net_amount, st.gross_amount)` | no sign logic | no sign logic | OK |
| 13 | `sales.vw_sale_transactions_export` | live viewdef — `st.total_quantity, st.gross_amount, st.net_amount` | no sign logic | no sign logic | OK |
| 14 | Sales page compute | `web/app/(ho)/sales/page.tsx:204-219`, `:346-358` — sums the view columns directly | no sign logic | no sign logic | OK |
| 15 | Replenishment demand | `web/lib/replenishment/compute.ts:343` — `if (r.bill_type !== "SALE" && r.bill_type !== "RETURN") continue;`. The old `const sign = bill_type === "RETURN" ? -1 : 1` is **gone** (see the explanatory comment at `compute.ts:356`) | reads as stored, single sign | reads as stored, single sign | OK (fixed in `014b1c5`) |
| 16 | Sale-vs-Stock Mix | `web/lib/replenishment/mix.ts:249` + comment at `mix.ts:256` | double-signing removed | double-signing removed | OK (fixed in `014b1c5`) |

**Conclusion on the code path**: after `014b1c5` there is exactly **one** place a sign is
applied — the ERP source — and every step downstream is a pass-through. **Value and quantity
are treated identically at every single step**; there is no place where the two diverge, and
no place where a sign is applied twice. The code is now correct.

**The remaining defect is entirely in the DATA, not the code** (finding C-01).

### Verdict on migration `0093_fix_synced_return_sign.sql`

| Check | Result |
|---|---|
| Covers `net_amount`? | YES — `net_amount = -abs(net_amount)` |
| Covers `gross_amount`? | YES — `gross_amount = -abs(gross_amount)` |
| Covers `total_quantity` (the user's flagged qty mismatch)? | **YES** — `total_quantity = -abs(total_quantity)`. All three fields are covered. **This is NOT a P0 gap.** |
| Idempotent? | YES — uses `-abs(...)`, not `* -1`. Re-running cannot flip a correct row back. |
| Scope-guarded? | YES — `where source = 'sale_detail_sync'`. Excel rows (`source IS NULL`, already correct) are untouched, so FY24-25 / FY25-26 data is safe. |
| Row guard `(total_quantity > 0 or net_amount > 0 or gross_amount > 0)` | Correct — a row positive on *any* field gets *all three* forced negative, so partially-broken rows are fully repaired. |
| Return detection | `bill_no like '%RB-%'` — a **prefix parse**, not a `bill_type` column. Consistent with every view (they use the same `LIKE '%RB-%'` test), but see finding C-04. |

**Migration 0093 is well-formed, complete (quantity included), and safe to run.
It simply has not been run.**

### Live data characterisation (real query output, 2026-08-27)

```sql
select coalesce(source,'(null=excel)') as src,
       count(*) filter (where bill_no like '%RB-%')                            as return_rows,
       count(*) filter (where bill_no like '%RB-%' and net_amount     > 0)     as ret_net_pos,
       count(*) filter (where bill_no like '%RB-%' and gross_amount   > 0)     as ret_gross_pos,
       count(*) filter (where bill_no like '%RB-%' and total_quantity > 0)     as ret_qty_pos,
       count(*) filter (where bill_no not like '%RB-%')                        as sale_rows,
       count(*) filter (where bill_no not like '%RB-%' and net_amount     < 0) as sale_net_neg,
       count(*) filter (where bill_no not like '%RB-%' and total_quantity < 0) as sale_qty_neg,
       count(*) as total
from raw_logic.sales_transactions group by 1 order by 1;
```

```
       src        | return_rows | ret_net_pos | ret_gross_pos | ret_qty_pos | sale_rows | sale_net_neg | sale_qty_neg | total
------------------+-------------+-------------+---------------+-------------+-----------+--------------+--------------+-------
 (null=excel)     |         984 |           0 |             0 |           0 |     18270 |            0 |            0 | 19254
 sale_detail_sync |         227 |         227 |           227 |         227 |      4529 |            0 |            0 |  4756
```

How to read that:

- **Excel rows are 100% correct** — 0 of 984 return rows positive on any field.
- **Sync rows are 100% wrong** — **all 227** return rows are positive on **net, gross AND
  quantity**. The three counts are identical (227 / 227 / 227), so the three fields agree in
  sign row-for-row: there is **no** row where value is negative but qty positive, or vice
  versa. Value and quantity are broken in lockstep — which is exactly why the user sees
  *both* mismatching, and by proportionally similar amounts.
- **No SALE row is negative** in either source — the reverse error does not exist.

Magnitude:

```sql
select count(*) rows, sum(total_quantity) qty, sum(net_amount) net, sum(gross_amount) gross
from raw_logic.sales_transactions
where source = 'sale_detail_sync' and bill_no like '%RB-%';
```

```
 rows | qty |    net    |   gross
------+-----+-----------+-----------
  227 | 227 | 279199.00 | 279156.76
```

Because a value that should read `-x` is stored as `+x`, the reported total is wrong by `2x`:

> **The dashboard currently overstates FY26-27 by +454 units, +Rs 5,58,398 net and
> +Rs 5,58,314 gross, network-wide.**

That reproduces migration 0093's own header numbers exactly, and reproduces the user's
ERP-comparison deltas (Undri +30 units / +Rs 36,088; Sinhgad +50 units / +Rs 60,226 for
01–25 Aug 2026).

Date coverage of the affected rows (`bill_date` is `text` in `DD/MM/YYYY`, so it must be
parsed before any range test — see C-06):

```sql
select coalesce(source,'excel') src,
       min(to_date(bill_date,'DD/MM/YYYY')) mind,
       max(to_date(bill_date,'DD/MM/YYYY')) maxd, count(*)
from raw_logic.sales_transactions where bill_no like '%/%' group by 1;
```

```
       src        |    mind    |    maxd    | count
------------------+------------+------------+-------
 sale_detail_sync | 2026-04-01 | 2026-08-26 |  4756
 excel            | 2024-12-05 | 2026-05-23 | 19219
```

So the corruption spans the **entire current fiscal year, 2026-04-01 to date**.
---

## PART 2 — Summary table of all findings

| ID | Sev | Area | One-line | Affects numbers? |
|----|-----|------|----------|------------------|
| C-01 | **P0** | Sign convention / data | Migration `0093` never run — all 227 sync-written RETURN rows still positive on net, gross **and qty** | **YES** — FY26-27 overstated by +454 units / +Rs 5,58,398 |
| C-02 | **P1** | Time-of-day parsing | `bill_time` from the sync is `H:MM:SS AM` (single-digit hour); `vw_ebo_sales_lines`' regex demands `HH:MM:SS AM`, so 4,246 of 4,756 sync rows parse to NULL and `vw_ebo_sales_hourly` drops them | **YES** — hourly chart shows Rs 5.6L of Rs 52.8L (89.4% missing) |
| C-03 | **P1** | PostgREST 1000-row cap | 6 unpaginated query sites silently truncate at 1000 rows (proven: stock 5,171→1,000; export 24,010→1,000; hourly 2,493→1,000; agent 1,585→1,000; scheme 1,715→1,000) | **YES** |
| C-04 | **P1** | Ecomm discount | `vw_ecomm_daily.discount_value` sums Uniware's `discount` column, which is 0 for AJIO (250/250 rows), TATACLIQ (35/36) and most SHOPIFY orders; the real discount is `mrp − selling_price` | **YES** — 27.47% reported vs 43.67% actual |
| C-05 | **P1** | Ecomm completeness | Only 1,552 of 4,867 Uniware orders have item lines synced; all Ecomm value/unit metrics cover ~32% of orders | **YES** (flagged by `revenue_incomplete`, but the number shown is still wrong) |
| C-06 | **P2** | Cross-source duplication | Excel upload and nightly sync assign `line_seq` independently, so the same physical bill line can be stored twice; proven live on `2627/3/SB-000343` | **YES** — currently +1 unit / +Rs 89 |
| C-07 | **P2** | Metric definition | `atv` is `sale_net_amount/sale_bills` at daily grain but `net_sales/sale_bills` (returns in numerator, not in denominator) at weekly and monthly grain | YES — weekly/monthly ATV understated by the returns value |
| C-08 | **P2** | Ecomm arithmetic | In `vw_ecomm_daily`, `units`, `gross_mrp_value` and `discount_value` include CANCELLED orders while `net_selling_value` excludes them — `discount_pct` mixes bases | YES — +86 units, +Rs 1.89L MRP, +Rs 58k discount from cancelled orders |
| C-09 | **P2** | Access control | `sales.vw_sale_transactions_export` and `sales.vw_stock_with_scheme` are `security_invoker=off`, have **no** `fn_user_store_ids()` filter, and are granted to `authenticated` — line-level, all-store data readable by any logged-in user directly over PostgREST | No (security, not arithmetic) |
| C-10 | **P2** | Store scoping | Two parallel exclusion mechanisms: SQL views filter `core.stores.is_active`, TypeScript hard-codes `store_id !== "BO-004" && !== "BO-002"` in 10 files. They can drift; the export view honours neither | Latent |
| C-11 | **P2** | Function asymmetry | `core.fn_user_store_ids()` has a `service_role` escape hatch; `core.fn_user_business_units()` does **not** — every `vw_ecomm_*` view returns zero rows to a service-role client, silently | Latent (no admin path reads ecomm today) |
| C-12 | **P3** | Test data in prod | 35 `TESTBILL_*` / `TESTBRANCH` rows (Rs 3,500) live in `raw_logic.sales_transactions` and surface in `vw_sale_transactions_export` and the merged download | Marginal |
| C-13 | **P3** | Missing COALESCE | `vw_sale_transactions_export.discount_amount = gross_amount - net_amount` with no `COALESCE`; 11 rows have `net_amount IS NULL` → NULL discount (sibling view `vw_ebo_sales_lines` does COALESCE) | Marginal |
| C-14 | **P3** | Schema typing | `raw_logic.sales_transactions.bill_date` is `text` in `DD/MM/YYYY`; every view re-parses it per row, no expression index, and any direct min/max/range on the raw column sorts lexically | Latent |
| C-15 | **P3** | Timezone | DB `TimeZone = UTC`; `CURRENT_DATE` in `vw_ebo_sales_daily`'s spine and `vw_ebo_target_achievement`, and `new Date()` in the app, are all UTC while the business runs IST (UTC+5:30) | Small edge (00:00–05:30 IST) |
| C-16 | **P3** | Master upload | `fn_process_master_upload` uses `coalesce(excluded.x, existing.x)` — a re-upload can set a field but can never clear one that the ERP has since blanked | Marginal |
| C-17 | **P3** | Missing FK indexes | 22 FK columns have no supporting index (e.g. `core.user_store_access.store_id`) | No (perf only) |

---

## Findings

### C-01 — P0 — Migration `0093` has not been run; all sync RETURN rows are still positive

**Where**: `server/db/migrations/0093_fix_synced_return_sign.sql` (written, unapplied) →
`raw_logic.sales_transactions`.

**Proof**: see Part 1's live characterisation. 227 / 227 / 227 sync return rows positive on
`net_amount`, `gross_amount`, `total_quantity`; 0 / 984 Excel return rows positive.

**Impact**: because the whole `sales.vw_ebo_*` chain sums as stored, a return that should
subtract now adds. Every FY26-27 headline number is wrong by **2×** the returns:

- **+454 units**
- **+Rs 5,58,398 net sales**
- **+Rs 5,58,314 gross sales**

Downstream, this also inflates `vw_ebo_sales_daily/_weekly/_monthly`,
`vw_ebo_sale_attribute_lines`, `ops.vw_ebo_target_achievement` (achievement %, gap, run
rates), `ops.vw_ebo_conversion_daily` (ATV, sales-per-footfall) and Replenishment demand.

**Root cause**: `0090`'s sync route shipped with a `toUnsigned()` helper that applied
`Math.abs()` to `signed_net_amount` / `signed_gross_amount` / `signed_quantity`. Commit
`014b1c5` fixed the code (future runs are correct) but the historical rows it already wrote
were left as-is, pending `0093`.

**Recommended fix**: run `0093` as written. It is idempotent (`-abs()`), covers all three
fields, and is scope-guarded to `source = 'sale_detail_sync'`. **No change to the migration
is needed.** After it runs, the "AFTER" block in the migration must print
`return_rows_still_positive = 0`.

Note: the nightly sync **re-upserts the whole current fiscal year on every run** (there is no
incremental cursor — see the route's header comment). Since `014b1c5` is deployed, a full sync
run would also repair these rows on its own. Running `0093` is the deterministic path.

---

### C-02 — P1 — 89% of current-FY sales are invisible to the hourly view (`bill_time` format)

**Where**: `sales.vw_ebo_sales_lines` (live viewdef) —

```sql
CASE WHEN st.bill_time ~ '^\d{2}:\d{2}:\d{2} (AM|PM)$'
     THEN to_timestamp(st.bill_time, 'HH12:MI:SS AM')::time
     ELSE NULL::time
END AS bill_time_parsed
```

and `sales.vw_ebo_sales_hourly` — `WHERE bill_type = 'SALE' AND bill_time IS NOT NULL`.

**Proof**:

```
select coalesce(source,'excel') src, count(*) n,
  count(*) filter (where bill_time is null or btrim(bill_time)='')                              as t_null,
  count(*) filter (where bill_time is not null
                     and bill_time !~ '^[0-9]{2}:[0-9]{2}:[0-9]{2} (AM|PM)$')                   as t_badfmt
from raw_logic.sales_transactions group by 1;

       src        |   n   | t_null | t_badfmt
------------------+-------+--------+----------
 sale_detail_sync |  4756 |      0 |     4246
 excel            | 19254 |     35 |        0
```

Sample failing values: `3:48:30 PM`, `5:57:11 PM`, `9:06:46 PM` — a **single-digit hour**, so
`^\d{2}` never matches. Excel-parsed rows are zero-padded and always match.

Downstream effect, measured:

```
 total SALE lines FY26-27         | 4530 | 5282363.00
 SALE lines with usable bill_time |  497 |  560728.00
 hourly view net FY26-27          |      |  560728.00
```

**Impact**: the Sales page's hourly / peak-hour analysis reports **Rs 5,60,728 against a real
Rs 52,82,363 — 89.4% of current-FY sales silently missing.** It has been getting worse every
day since the sync started (2026-04-01).

**Root cause**: the regex was written against the Excel export's zero-padded format; migration
`0090`'s sync writes the ERP's own non-padded `bill_time` verbatim.

**Recommended fix**: relax the guard to accept 1–2 digit hours, e.g.
`~ '^\d{1,2}:\d{2}:\d{2} (AM|PM)$'` (`to_timestamp(..., 'HH12:MI:SS AM')` already parses
`3:48:30 PM` correctly), or normalise `bill_time` in the sync route with `lpad`. The regex
change is one line in `vw_ebo_sales_lines` and needs no data backfill.

---

### C-03 — P1 — PostgREST 1000-row cap: six unpaginated call sites silently truncate

Supabase's project "Max Rows" setting caps **every** response at 1000 regardless of `.limit()`
— already documented in `web/lib/data/client.ts:76-88` and worked around by `fetchAllRows()`
(`lib/data/client.ts:90`). Only **5 files** use it. The sites below do not.

See the dedicated section "PostgREST 1000-row truncation audit" below for the full table with
proven live row counts.

---

### C-04 — P1 — Ecomm discount is understated because Uniware's `discount` column is often 0

**Where**: `sales.vw_ecomm_daily` — `sum(vw_ecomm_order_lines.discount) AS discount_value`
and `round(100.0 * discount_value / NULLIF(gross_mrp_value,0), 2) AS discount_pct`, sourced
from `raw_uniware.sale_order_items.discount`.

**Proof** — how often `mrp = selling_price + discount` actually holds, by channel:

```
    channel    |  n   |  ok
---------------+------+------
 MYNTRA        | 1242 | 1197
 SHOPIFY       |  408 |   63
 AJIO_DROPSHIP |  250 |    0
 FIRSTCRY      |   64 |   62
 TATACLIQ      |   36 |    1
```

Example failing rows (`discount` recorded as 0 while the item sold far below MRP):

```
 mrp  | selling_price | discount |  delta
------+---------------+----------+---------
 2049 |        658.74 |        0 | 1390.26
 3199 |       1028.48 |        0 | 2170.52
 1799 |        578.38 |        0 | 1220.62
```

Aggregate impact:

```
   mrp   |  selling   | discount_col | implied (mrp-selling) | reported_pct | true_pct
---------+------------+--------------+-----------------------+--------------+----------
 4157923 | 2341957.68 |   1142242.74 |            1815965.32 |       27.47  |   43.67
```

**Impact**: the Ecomm discount figure on the Sales page reads **27.47%** where the realised
discount is **43.67%** — understated by Rs 6.74 lakh, and essentially fabricated for AJIO
(reported 0% discount on 250 lines).

**Root cause**: `discount` is a channel-reported field that AJIO/Shopify/TataCliq do not
populate; the arithmetic truth is `mrp − selling_price`.

**Recommended fix**: derive discount as `greatest(mrp - selling_price, 0)` (or
`coalesce(nullif(discount,0), mrp - selling_price)`) inside `vw_ecomm_order_lines`, rather
than trusting the source column. Note one row has `discount (1144) > mrp (1199)` with
`selling_price = 1055` — clamp negatives.

---

### C-05 — P1 — Ecomm value metrics cover only 32% of orders

**Proof**:

```
select count(*) orders, count(*) filter (where items_synced_at is not null) enriched,
       min(order_datetime)::date, max(order_datetime)::date from raw_uniware.sale_orders;

 orders | enriched |    min     |    max
--------+----------+------------+------------
   4867 |     1552 | 2026-07-08 | 2026-08-27

select count(distinct sale_order_code) orders_with_items, count(*) item_rows
from raw_uniware.sale_order_items;
 orders_with_items | item_rows
-------------------+-----------
              1552 |      2000
```

**Impact**: `units`, `net_selling_value`, `gross_mrp_value` and `discount_value` in
`vw_ecomm_daily` are computed from 1,552 of 4,867 orders. `total_orders` and
`cancelled_orders` (which come from `sale_orders`) are complete, so **order counts and value
on the same row of the same view are on different denominators.**

`vw_ecomm_daily` does expose `revenue_incomplete` (`o.enriched_orders < o.total_orders`), so
the condition is known — but the value shown is still ~1/3 of reality. This is a sync backlog
(`api/cron/uniware-sync` enriches order items in batches), not a view bug.

**Recommended fix**: surface `revenue_incomplete` prominently on the Ecomm cards, or suppress
value metrics for a day until it is false. Separately, let the enrichment sync catch up.

---

### C-06 — P2 — Excel upload and nightly sync can store the same bill line twice

**Where**: `raw_logic.sales_transactions` unique constraint
`sales_transactions_natural_key UNIQUE (branch_name, bill_date, bill_no, item_code, line_seq)`,
combined with `line_seq` being derived **independently** by each writer:

- `web/app/api/cron/sale-detail-sync/route.ts:157-160` — `const seqCounter = new Map(); … const lineSeq = (seqCounter.get(key) ?? 0) + 1;`
- `web/lib/erpReports/parseSaleWorkbook.ts` — numbers repeat lines from the workbook the same way

Because the two sources aggregate at different grains (the ERP `sale_detail` primary key
includes `sold_mrp` and `bill_type`; the Excel export does not), the same physical line can get
`line_seq = 1` from one writer and `line_seq = 2` from the other, and the `ON CONFLICT` never
fires.

**Proof** — bill `2627/3/SB-000343`, item `8905385747729`, dated 23/05/2026:

```
  id   |      branch_name      | bill_date  |     bill_no      |   item_code   | line_seq | qty | gross | net |       src
-------+-----------------------+------------+------------------+---------------+----------+-----+-------+-----+------------------
 19155 | BO-001 - PUNE - UNDRI | 23/05/2026 | 2627/3/SB-000343 | 8905385747729 |        1 |   2 |   178 | 178 | sale_detail_sync
 19156 | BO-001 - PUNE - UNDRI | 23/05/2026 | 2627/3/SB-000343 | 8905385747729 |        2 |   1 |    89 |  89 | excel
```

The sync wrote the ERP's aggregated line (qty 2, Rs 178); an earlier Excel upload had already
written a split line (qty 1, Rs 89) at `line_seq = 2`. The bill now totals **3 units / Rs 267
instead of 2 units / Rs 178**.

**Current blast radius is small** — the Excel and sync date ranges barely overlap:

```
select count(*) bills_in_both_sources from (
 select branch_name,bill_date,bill_no from raw_logic.sales_transactions where source is null
 intersect
 select branch_name,bill_date,bill_no from raw_logic.sales_transactions where source='sale_detail_sync') x;
 -> 1

select count(*), sum(net_amount), sum(total_quantity) from raw_logic.sales_transactions
where source is null and to_date(bill_date,'DD/MM/YYYY') >= '2026-04-01';
 -> 1 row, 89, 1
```

**Impact today**: +1 unit, +Rs 89. **Impact if anyone re-uploads an Excel file covering a date
the sync already owns**: unbounded double counting, with no error and no unique-constraint
violation.

**Recommended fix**: refuse (or auto-delete) Excel rows for dates the sync owns — the sync
already scopes itself to `fin_year >= currentFinYear()`, so the same guard belongs in the
sale-upload commit path. Longer term the natural key should not depend on a locally derived
`line_seq`.

---

### C-07 — P2 — `atv` is defined differently at daily vs weekly/monthly grain

**Where**:

- `sales.vw_ebo_sales_daily`: `round(t.sale_net_amount / NULLIF(t.sale_bills, 0), 2) AS atv`
  — numerator is `sum(net_amount) FILTER (WHERE bill_type = 'SALE')`.
- `sales.vw_ebo_sales_weekly`: `round(sum(net_sales) / NULLIF(sum(sale_bills), 0), 2) AS atv`
  — numerator is **`net_sales`, which includes RETURN bills**.
- `sales.vw_ebo_sales_monthly`: identical to weekly.

**Impact**: weekly/monthly ATV divides a returns-inclusive numerator by a returns-exclusive
denominator, so it is systematically lower than the daily ATV of the same period and is not a
true "average transaction value". `upt` is *not* affected (weekly uses `sum(sale_quantity)`,
which is correctly SALE-only).

The semantic layer half-acknowledges this: `workspace.metric_sources` registers
`atv_sale_bills_only` at daily grain and plain `atv` at weekly grain — but both are
`is_default = true` for their grain, so a workspace switching grain silently switches
definition.

**Recommended fix**: make weekly/monthly ATV `sum(sale_net_amount)/sum(sale_bills)` by carrying
a `sale_net_amount` column through `vw_ebo_sales_daily`.

---

### C-08 — P2 — `vw_ecomm_daily` mixes cancelled and non-cancelled orders across its own columns

**Where**: `sales.vw_ecomm_daily`, CTE `lines_agg`:

```sql
count(*)                                                              AS units,
sum(selling_price)                                                    AS gross_selling_value,
sum(selling_price) FILTER (WHERE status <> 'CANCELLED')               AS net_selling_value,
sum(mrp)                                                              AS gross_mrp_value,
sum(discount)                                                         AS discount_value
```

Only `net_selling_value` filters out cancelled orders. `units`, `gross_mrp_value` and
`discount_value` do not — and `discount_pct` then divides a cancelled-inclusive numerator by a
cancelled-inclusive denominator while sitting next to a cancelled-exclusive value column.

**Proof**:

```
   status   | line_rows |    sell    |   mrp   |    disc
------------+-----------+------------+---------+------------
 COMPLETE   |      1887 | 2208211.81 | 3908640 | 1069013.30
 CANCELLED  |        86 |  102277.68 |  189110 |   58173.66
 PROCESSING |        27 |   31468.19 |   60173 |   15055.78
```

**Impact**: `units` overstates by 86 (4.3%); `gross_mrp_value` by Rs 1,89,110;
`discount_value` by Rs 58,174.

---

### C-09 — P2 — Two views expose all-store line-level data to any authenticated user

**Where** (live `pg_class.reloptions` + `information_schema.role_table_grants`):

```
 vw_sale_transactions_export | {security_invoker=off,security_barrier=true} | {authenticated,postgres,service_role}
 vw_stock_with_scheme        | {security_invoker=off,security_barrier=true} | {authenticated,postgres,service_role}
```

Both are `security_invoker = off` (they run as the definer and bypass RLS on the base tables),
and **neither** carries a `store_id = ANY (core.fn_user_store_ids())` predicate — unlike every
`vw_ebo_*` view, which does. `vw_sale_transactions_export` joins `core.stores` with a plain
`LEFT JOIN` and no `is_active` test.

The `app/api/data-upload/download-merged/route.ts` route does check
`ALLOWED_ROLES.includes(profile.role)`, but that is a route-level guard; the view itself is
reachable directly over PostgREST with any `authenticated` JWT.

**Impact**: a store-scoped user can read every store's bill-level sales and every branch's
stock. Also explains a reporting inconsistency: the export contains **24,010** rows while
`vw_ebo_sales_lines` contains **22,344** — the 1,666-row difference is exactly
1,631 BO-004 rows + 35 `TESTBRANCH` rows.

---

### C-10 — P2 — Store exclusion is implemented twice, in two different layers

SQL views exclude via `JOIN core.stores s ON … AND s.is_active`. TypeScript excludes via a
hard-coded id list, repeated in **10 files**:

```
app/(admin)/users/page.tsx:119, app/(ebo)/footfall/page.tsx:85, app/(ho)/sales/page.tsx:1114,
app/(ho)/targets/page.tsx:377, app/(stock-details)/stock-details/page.tsx:319,
app/(workspace)/workspace/page.tsx:66, lib/replenishment/compute.ts:230,
lib/replenishment/mix.ts:150, lib/workspace/renderStockComponents.tsx:60
  -> .filter((s) => s.store_id !== "BO-004" && s.store_id !== "BO-002")
```

`server/db/migrations/0091_bo002_bo004_stores.sql`'s own header states this was a deliberate
choice ("rather than switching to an is_active-driven filter"). The exclusion of BO-004's
1,631 rows / Rs 25,11,213 / 1,524 units is therefore **intended**, not a bug — but it is worth
stating explicitly because it is a real, provable reason a network total in this dashboard will
not match an ERP report that includes Lucknow:

```
select st.branch_name, count(*) rows, sum(st.net_amount) net,
       max(case when s.store_id is not null then 1 else 0 end) as has_active_store
from raw_logic.sales_transactions st
left join core.stores s on s.branch_name_erp = st.branch_name and s.is_active
group by 1 order by has_active_store, rows desc;

             branch_name             | rows  |     net     | has_active_store
-------------------------------------+-------+-------------+------------------
 BO-004 - LUCKNOW - PHOENIX PALASSIO |  1631 |  2511213.00 |                0
 TESTBRANCH                          |    35 |        3500 |                0
 BO-003 - PUNE - SINHGAD ROAD        | 12695 | 14031212.80 |                1
 BO-001 - PUNE - UNDRI               |  9649 | 10550093.82 |                1
```

BO-004's data is entirely Excel-era (`2024-12-10 .. 2025-05-01`), so it does **not** affect any
FY26-27 comparison.

**Risk**: the two mechanisms can drift. Deactivating a store in `core.stores` silently changes
every view but no TS page; adding a store id to the TS filter changes every page but no view.
`vw_sale_transactions_export` honours neither.

---

### C-11 — P2 — `fn_user_business_units()` has no `service_role` branch

```sql
-- core.fn_user_store_ids()  (has the escape hatch)
when coalesce(current_setting('request.jwt.claims', true)::json ->> 'role','') = 'service_role'
  then (select array_agg(store_id) from core.stores)

-- core.fn_user_business_units()  (does not)
select array_agg(business_unit) from core.user_business_units
where user_id = core.current_user_id();
```

For a service-role client `current_user_id()` resolves to nothing, so the function returns
`NULL`, and `'ecomm' = ANY (NULL)` is `NULL` — every `vw_ecomm_*` view returns **zero rows with
no error**. No admin/service-role path reads the ecomm views today (`lib/exports/scheduledExports.ts`
and `lib/alerts/runDueAlerts.ts` read only `vw_ebo_*` / `vw_footfall_*` / `ops.*`, all of which
go through `fn_user_store_ids()`), so this is latent — but it is a silent-zero trap for the
next scheduled export or alert that touches Ecomm.

---

### C-12 — P3 — Synthetic test rows in the production sales table

```
select distinct regexp_replace(bill_no,'[0-9]+','N','g') as pattern, count(*)
from raw_logic.sales_transactions group by 1 order by 2 desc;

   pattern    | count
--------------+-------
 N/N/SB-N     | 22764
 N/N/RB-N     |  1211
 TESTBILL_A-N |    20
 TESTBILL_B-N |    15
```

35 rows, `branch_name = 'TESTBRANCH'`, Rs 3,500, inserted 2026-08-25. They are excluded from
every `vw_ebo_*` view (no matching `core.stores` row) but **are** included in
`vw_sale_transactions_export`, therefore in the merged-file download and in Replenishment's
raw fetch (where they are then dropped by the `storeBranchToId` lookup at
`lib/replenishment/compute.ts:341`). Their `bill_type` is `'OTHER'` (neither `SB-` nor `RB-`).

---

### C-13 — P3 — `discount_amount` can be NULL in the export view

`sales.vw_sale_transactions_export`: `st.gross_amount - st.net_amount AS discount_amount` —
no `COALESCE`, unlike the sibling `sales.vw_ebo_sales_lines`, which uses
`st.gross_amount - COALESCE(st.net_amount, st.gross_amount)`.

11 rows have `net_amount IS NULL`, so those export rows carry a NULL discount, and any
JS consumer doing `Number(null)` gets `0` rather than a flagged gap.

---

### C-14 — P3 — `bill_date` is `text`, not `date`

`raw_logic.sales_transactions.bill_date text` holding `DD/MM/YYYY`. Consequences:

- Every view re-parses it per row via a `CASE … to_date(...)` in a `CROSS JOIN LATERAL`;
  there is no expression index on `to_date(bill_date,'DD/MM/YYYY')`.
- Any ad-hoc `min()`/`max()`/range predicate on the raw column sorts **lexically**, not
  chronologically — e.g. `max(bill_date)` on the sync rows returns `'31/05/2026'` when the real
  maximum is `2026-08-26`. (This bit me during this audit; it will bite anyone writing an
  ad-hoc query.)
- The unique constraint is on the text form, so `'01/04/2026'` and `'1/4/2026'` would be two
  different rows.

Not currently wrong anywhere in the app (all app filters go through the views' parsed date),
but it is a standing trap.

---

### C-15 — P3 — UTC/IST

See the Timezone analysis section.

---

### C-16 — P3 — Master upload can set a field but never clear one

`ops.fn_process_master_upload` (`0088`):
`item_name = coalesce(excluded.item_name, raw_logic.item_master.item_name)` — repeated for all
12 attribute columns. If the ERP master corrects a value to blank, the stale value survives
every future upload. (Blanks arrive as NULL from the parser.)

---

### C-17 — P3 — 22 foreign-key columns without a supporting index

```
core.user_store_access.store_id, ops.ebo_footfall_daily.entered_by/updated_by,
ops.ebo_targets.set_by, ops.action_items.owner_user_id, marketing.campaigns.import_batch_id,
marketing.campaign_recipients.import_batch_id, raw_logic.stock_snapshot.upload_id,
raw_logic.scheme_lookup.upload_id, workspace.workspace_components.component_id, …
```

All are on small tables today. Performance only; listed for completeness.
---

## PostgREST 1000-row truncation audit — every at-risk call site

Live row counts (queried with `select set_config('request.jwt.claims','{"role":"service_role"}', true)`
inside a `begin read only;` block so `core.fn_user_store_ids()` resolves to all stores):

```
              view               | rows
---------------------------------+-------
 vw_ebo_agent_daily              |  2750
 vw_ebo_bill                     | 11247
 vw_ebo_sale_attribute_lines     | 22344
 vw_ebo_sales_daily              |  2670
 vw_ebo_sales_hourly             |  4988
 vw_ebo_sales_lines              | 22344
 vw_ebo_sales_monthly            |    94
 vw_ebo_sales_weekly             |   384
 vw_ebo_scheme_daily             |  2849
 vw_sale_transactions_export     | 24010
 vw_stock_with_scheme            | 46656
 vw_ecomm_order_lines            |  2000   (base tables; the view itself needs an ecomm JWT)
```

Windowed counts for the ranges the app actually asks for:

```
 hourly, last 365d       |  2493
 agent_daily, last 365d  |  1585
 scheme_daily, last 365d |  1715
 sales_daily, last 400d  |   802
 attr_lines, last 365d   | 14174
 vw_stock_with_scheme, the 2 active store branches (BO-001 + BO-003) | 5171
```

### At-risk sites

| # | File:line | Query | Rows available | Returned | Sev |
|---|-----------|-------|----------------|----------|-----|
| 1 | `web/app/(stock-details)/stock-details/page.tsx:135-141` — `.from<StockRow>("vw_stock_with_scheme").select(...).in("branch_name", branchFilter).limit(20000)` | store stock detail | **5,171** (2 active branches) | **1,000** | **P1** |
| 2 | `web/app/api/data-upload/download-merged/route.ts:95-108` — `.from<ExportRow>("vw_sale_transactions_export").select(...).limit(EXPORT_ROW_LIMIT)` where `EXPORT_ROW_LIMIT = 200_000` (`:54`) | merged sale-file download | **24,010** | **1,000** | **P1** |
| 3 | `web/app/(ho)/sales/page.tsx:352` — `.from<HourlyRow>("vw_ebo_sales_hourly").select("*").gte("bill_date", from).lte("bill_date", to)` | hourly heat map | 2,493 (365d) | 1,000 | **P1** |
| 4 | `web/app/(ho)/sales/page.tsx:349` — `.from<AgentDailyRow>("vw_ebo_agent_daily").select("*")…` | agent leaderboard | 1,585 (365d) | 1,000 | **P1** |
| 5 | `web/app/(ho)/sales/page.tsx:609` and `:690` — `.from<SchemeDailyRow>("vw_ebo_scheme_daily").select("*")…` | scheme penetration | 1,715 (365d) | 1,000 | **P1** |
| 6 | `web/app/(ho)/sales/page.tsx:855-858` — `.from<EcommLineRow>("vw_ecomm_order_lines").select(...)` (no `.limit()` at all) | Ecomm channel table | 2,000 today, growing with every sync | 1,000 | **P1** |
| 7 | `web/app/(ho)/sales/page.tsx:355`, `:688`; `web/app/(ebo)/footfall/page.tsx:62`; `web/app/api/footfall/download/route.ts:93`; `web/lib/exports/scheduledExports.ts:194` — `vw_ebo_sales_daily` unpaginated | daily series | 802 for a 400-day window with 2 stores; **2,670 total** | full today | **P2 — latent**: crosses 1000 at ~500 days × 2 stores, or immediately at 2 stores × 500 days, or as soon as a 3rd store is activated |
| 8 | `web/app/(ho)/sales/page.tsx:346`, `:366`, `:689`; `app/(ebo)/my-store/page.tsx:23`; `lib/alerts/runDueAlerts.ts:112`; `app/(configurations)/configurations/actions.ts:129` — `vw_ebo_sales_weekly` unpaginated | weekly series | 384 total | full today | P3 — latent |
| 9 | `web/app/(ho)/sales/page.tsx:868` — `vw_ecomm_returns` unpaginated | returns list | 150 today | full today | P3 — latent |

Site 1's own inline comment (`stock-details/page.tsx:125-129`) says the `.limit(20000)` was
added because "an unfiltered query was hitting the `.limit(20000)` cap exactly (silently
truncating)". That diagnosis was wrong: the cap being hit is PostgREST's Max Rows = 1000, not
the `.limit()`. Narrowing to store branches reduced the row count from 46,656 to 5,171 — still
5× over the cap.

### Correctly paginated (verified)

| File:line | Mechanism |
|---|---|
| `web/lib/data/client.ts:90` — `fetchAllRows()` | `.range(from, from+pageSize-1)` loop, `pageSize = 1000` |
| `web/app/(ho)/sales/page.tsx:558-578` — `vw_ebo_sale_attribute_lines` | `fetchAllRows()` **plus** a 3-column `.order()` (required for a correct `.range()` partition) |
| `web/lib/replenishment/compute.ts:205-224` — `vw_stock_with_scheme`, `vw_sale_transactions_export` | `fetchAllRows()` + `.order()` |
| `web/lib/replenishment/mix.ts:130-146` — same pair | `fetchAllRows()` + `.order()` |
| `web/lib/salesSource/client.ts:116+` — `fetchAllSalesSourceRows()` | `.range()` loop against the ERP project |
| `web/app/api/targets/monthly/audit-report/route.ts:144-172` | keyset pagination on `line_id` (`.gt("line_id", cursor).order("line_id").limit(1000)`) — backend-agnostic, correct |
| `web/lib/exports/scheduledExports.ts:284-306` | same keyset pattern on `line_id` |

---

## View-by-view arithmetic check

Every view definition below was dumped live with `pg_get_viewdef(..., true)` and re-derived by
hand.

| View | Arithmetic | Verdict |
|---|---|---|
| `sales.vw_ebo_sales_lines` | `COALESCE(net_amount, gross_amount)`; `discount = gross - COALESCE(net, gross)`; `bill_type` from `bill_no LIKE`; `JOIN core.stores … AND s.is_active`; `LEFT JOIN item_master` | **OK** — no fan-out: `item_master_pkey PRIMARY KEY (item_code)`, and 0 duplicate `item_code` confirmed live. Row count 22,344 = 24,010 raw − 1,631 BO-004 − 35 TESTBRANCH, exactly. |
| `sales.vw_ebo_bill` | `sum()` per bill; `count(*) AS line_count`; `count(DISTINCT scheme_group_name) FILTER (…)`; `dominant_scheme` via `DISTINCT ON … ORDER BY group_net DESC` | **OK.** `DISTINCT ON` is deterministic given the ORDER BY; ties break arbitrarily but only affect a label, never a total. The `LEFT JOIN dominant_scheme USING (store_id, bill_date, bill_no)` cannot fan out — `dominant_scheme` is `DISTINCT ON` those exact three columns. |
| `sales.vw_ebo_sales_daily` | Calendar **spine** `LEFT JOIN` bill totals, so zero-sales days materialise as 0 rather than vanishing; `COALESCE(…, 0)` on all six measures | **OK, and notably good** — the missing-`COALESCE`-turns-a-total-into-NULL trap is explicitly avoided. `atv`/`upt`/`discount_pct` are *deliberately* left NULL (via `NULLIF` denominators) on zero-bill days, which is correct. |
| " | `atv = sale_net_amount / sale_bills` | SALE-only numerator — correct here; **inconsistent with weekly/monthly, see C-07** |
| `sales.vw_ebo_sales_weekly` | `sum()` over daily; `is_complete_week = (max(bill_date) - min(week_start)) >= 6` | Sums OK. `atv` — **see C-07**. `upt = sum(sale_quantity)/sum(sale_bills)` correct. |
| `sales.vw_ebo_sales_monthly` | `date_trunc('month', bill_date::timestamptz)::date` | **OK.** `bill_date` is already a `date`; the cast to `timestamptz` and back round-trips in any single session TimeZone, so the month bucket is stable. (Verbose but not wrong.) |
| `sales.vw_ebo_agent_daily` | `WHERE bill_type='SALE'` at LINE level; `count(DISTINCT bill_no)` | **OK.** `count(DISTINCT bill_no)` (not `count(*)`) is the right call at line grain. Note the view is returns-**exclusive** by design, so agent totals will not add up to network net sales. |
| `sales.vw_ebo_scheme_daily` | `count(*) FILTER (bill_type='SALE')` over `vw_ebo_bill` (bill grain) | **OK** — `count(*)` is correct here because the source is already one row per bill. |
| `sales.vw_ebo_sales_hourly` | `EXTRACT(hour FROM bill_time)::smallint`; `WHERE bill_time IS NOT NULL` | **BROKEN — C-02.** The arithmetic is fine; the input is silently NULL for 89% of current-FY rows. |
| `sales.vw_ebo_sale_attribute_lines` (0092) | `COALESCE(NULLIF(TRIM(st.x),''), NULLIF(TRIM(im.x),''))` per attribute; `COALESCE(st.mrp, im.mrp)` | **OK.** Attribute coverage verified live: 0 NULLs on season/category/gender/size_group/shade/mrp in both eras; 567 NULL `pack_size` in the sync era only (the sync route does not fetch `pack_size` and item_master lacks it for those barcodes) — `pack_size` is not currently used by the Sales page. |
| `sales.vw_sale_transactions_export` | fiscal-year `CASE` on month `>= 4`; `discount_amount = gross - net` | Fiscal-year logic **correct** (Apr–Mar). `discount_amount` missing `COALESCE` — **C-13**. No store scoping — **C-09**. |
| `sales.vw_stock_with_scheme` (0084) | `LEFT JOIN item_master`, `LEFT JOIN scheme_lookup` on `item_code`; `coalesce(sl.is_discounted_50plus, false)` | **OK — no fan-out.** Both join targets have `PRIMARY KEY (item_code)`, and 0 duplicate `item_code` in each confirmed live. The `coalesce(..., false)` on `is_eoss` is exactly right (a barcode absent from the scheme master must read Fresh, not NULL). |
| `sales.vw_item_subcategory_lookup` | passthrough of `item_master` with `NULLIF(TRIM(...))` | **OK** — 0 duplicate `item_code`, so its use as a `LEFT JOIN` target in the audit-lines view cannot fan out. |
| `ops.vw_ebo_conversion_daily` | `LEFT JOIN ops.ebo_footfall_daily f ON f.store_id = d.store_id AND f.date = d.bill_date` | **OK — no fan-out.** `ebo_footfall_daily_store_id_date_key UNIQUE (store_id, date)` confirmed. `conversion_pct` and `sales_per_footfall` both guard `WHEN f.footfall > 0` and return NULL otherwise — correct, no division by zero, no misleading 0. |
| `ops.vw_ebo_target_achievement` | `achievement_pct = 100.0 * mtd / NULLIF(target,0)`; `days_remaining = GREATEST(period_end - CURRENT_DATE, 0) + 1`; `current_daily_run_rate = mtd / EXTRACT(day FROM CURRENT_DATE)` | Guards are right (`NULLIF` on both denominators). Two soft issues: `current_daily_run_rate` divides by calendar day-of-month regardless of whether the store traded, and `CURRENT_DATE` is UTC (C-15). `100.0 *` forces numeric — no integer division. |
| `ops.vw_monthly_fresh_disc_audit_lines` | `discount_amount / gross_amount < 0.495` bucketing, or `scheme_lookup` when `core.app_settings.fresh_disc_classification_source = 'scheme_lookup'` | **OK, and sign-safe**: on a RETURN row both `discount_amount` and `gross_amount` are negative, so the ratio stays positive and the bucket is unchanged. The `gross_amount = 0` case is explicitly handled before the division. |
| `sales.vw_ecomm_orders` | `order_datetime::date`; `WHERE 'ecomm' = ANY (core.fn_user_business_units())` | **C-11** (service-role blind spot). `order_datetime` is `timestamptz`, so `::date` is evaluated in the session TimeZone — see Timezone analysis. |
| `sales.vw_ecomm_order_lines` | `JOIN sale_order_items i ON i.sale_order_code = o.code` | Correct grain — `sale_order_items_sale_order_code_item_code_key UNIQUE (sale_order_code, item_code)` and no quantity column (Uniware emits one row per unit), so `count(*) AS units` in the parent is right. |
| `sales.vw_ecomm_daily` | see C-04, C-08 | **BROKEN** on `discount_value` (C-04) and cancelled-order handling (C-08). The `orders_agg`/`lines_agg` split with `LEFT JOIN … USING (channel, order_date)` is structurally correct and cannot fan out. |

### Numeric typing

Every money and quantity column in the chain is `numeric` (checked: `total_quantity`,
`gross_amount`, `net_amount`, `mrp`, `closing_stock`, `rate`, `selling_price`, `total_price`,
`discount`). **No `float`/`double precision` anywhere in the money path** — no binary
floating-point drift. All percentage expressions multiply by `100.0` (numeric literal), so
**there is no integer division** anywhere in the views.

### Discount / MRP / net-value sanity (live, both sources)

```
       src        | sale_net_gt_gross | sale_equal | sale_disc_pos | sale_total_disc | disc_pct
------------------+-------------------+------------+---------------+-----------------+----------
 sale_detail_sync |                96 |        933 |          3500 |      3192785.00 |    37.67
 excel            |               323 |       3230 |         14671 |     13631568.39 |    37.45
```

The two independent sources agree on realised discount to within 0.22pp (37.67% vs 37.45%),
which confirms `gross_amount` and `net_amount` mean the same thing in both — the sync's field
mapping is right. Cross-check against MRP:

```
select coalesce(source,'excel') src, count(*), sum(mrp*total_quantity - gross_amount) implied
from raw_logic.sales_transactions where bill_no like '%SB-%' and mrp is not null group by 1;

       src        | count |  implied
------------------+-------+-----------
 sale_detail_sync |  4529 | -66819.75
 excel            | 18234 |    -31880
```

`gross_amount ≈ mrp × quantity` to within 0.1% on both sources — so `gross` is the MRP value
and `net` is realised, consistently. **Migration `0083`** (adds the `discount_value`/`weekly`
row to `workspace.metric_sources`) and **`0084`** (adds `im.mrp` to `vw_stock_with_scheme`) are
both applied and correct.

419 rows (96 sync + 323 excel) have `net_amount > gross_amount`, i.e. a **negative discount**,
by small amounts (typically Rs 0.50 — rounding in the ERP). Not an app defect; noted so it is
not mistaken for one later.

---

## Timezone analysis

**Database `TimeZone = UTC`** (`show timezone` → `UTC`; `now()` → `2026-08-27 06:49:19+00`;
`current_date` → `2026-08-27`).

**All business dates are `date`, not `timestamp` or `timestamptz`.** Confirmed by
enumerating `information_schema.columns`: `bill_date`, `order_date`, `week_start`,
`month_start`, `period_month`, `return_date`, `as_of_date`, `retail_calendar.date` are all
`date`. Every `timestamptz` column in the schema is an audit field (`created_at`,
`updated_at`, `loaded_at`, `_synced_at`, `granted_at`, `_airbyte_extracted_at`) and none of
them is used for bucketing.

**Therefore: no period total in the EBO chain is shifted by a timezone.** `bill_date` is parsed
from the ERP's own `DD/MM/YYYY` text, which is already the store's local business date; it
never passes through a UTC instant. `date_trunc('month', bill_date::timestamptz)::date` in
`vw_ebo_sales_monthly` and `vw_ebo_target_achievement` round-trips cleanly in any single
session TimeZone. `0082_semantic_layer_verticals_and_grains.sql` introduces no date arithmetic
of its own — it seeds `workspace.metric_definitions` / `dimension_definitions` /
`metric_sources`, all of which point at views that were already date-typed. **The user's "IST vs
UTC" concern does not explain the ERP mismatch.**

Three genuinely UTC-dependent spots remain, all minor (C-15):

1. `sales.vw_ebo_sales_daily`'s spine — `JOIN core.retail_calendar rc ON … rc.date <= CURRENT_DATE`.
   Between **00:00 and 05:30 IST** the UTC date is still yesterday, so today's spine row does
   not exist yet and "today" reads as absent rather than zero. Stores are shut at that hour;
   the practical effect is an overnight report or alert missing the current day.
2. `ops.vw_ebo_target_achievement` — `days_remaining` and `current_daily_run_rate` both key off
   `CURRENT_DATE`, so during that same 5.5-hour window the run-rate divisor is one day short
   (overstating the current run rate) and `days_remaining` is one too many.
3. `web/app/(ho)/sales/page.tsx:1043` — `const today = new Date()` on the server. Vercel runs
   UTC, so default date ranges are computed on the UTC date. Display code is correct
   (`toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })` is used consistently — see
   `app/(stock-details)/stock-details/capacity-editor.tsx:19-29`, which documents exactly this
   trap).

`sales.vw_ecomm_orders` is the one place a real instant is bucketed:
`o.order_datetime::date AS order_date`, where `order_datetime` is `timestamptz`. Evaluated in
UTC, an order placed between 00:00 and 05:30 IST lands on the **previous** day's Ecomm figures.
This is a genuine (small) day-boundary shift and the one place `at time zone 'Asia/Kolkata'`
would be worth adding.

**Recommended**: set the Supabase project's database TimeZone to `Asia/Kolkata`, or replace
`CURRENT_DATE` with `(now() at time zone 'Asia/Kolkata')::date` and `order_datetime::date`
with `(order_datetime at time zone 'Asia/Kolkata')::date`. Low priority relative to C-01/C-02.

---

## Schema hygiene

**Good:**

- `raw_logic.sales_transactions` has a real natural key —
  `sales_transactions_natural_key UNIQUE (branch_name, bill_date, bill_no, item_code, line_seq)`
  — and both writers (`ops.fn_process_sale_upload`, `ops.fn_upsert_synced_sale_rows`) use
  `ON CONFLICT … DO UPDATE` against it. Re-running either with the same file/window is
  idempotent. (The cross-source caveat is C-06.)
- `raw_logic.item_master` and `raw_logic.scheme_lookup` are keyed `PRIMARY KEY (item_code)` —
  this is what makes the `LEFT JOIN`s in `vw_ebo_sales_lines` and `vw_stock_with_scheme`
  fan-out-proof.
- `ops.ebo_footfall_daily` has `UNIQUE (store_id, date)` plus `CHECK (footfall >= 0)` and a
  `CHECK (source IN ('manual','erp','sensor'))`.
- `raw_uniware.sale_order_items` has `UNIQUE (sale_order_code, item_code)` and
  `FOREIGN KEY (sale_order_code) REFERENCES sale_orders(code) ON DELETE CASCADE`.
- `ops.fn_process_stock_upload` does `delete from raw_logic.stock_snapshot;` then a bulk insert
  — a true full replace, so re-uploading cannot duplicate stock. **Important**: this function
  was *not* converted to the batched pattern that `0088`/`0089` applied to master and sale
  uploads. If it ever is, the unconditional `DELETE` must move out of the per-batch function or
  every batch will wipe its predecessors.
- Every one of the 32 views created across migrations `0000`–`0093` exists in the live DB
  (diffed `pg_get_viewdef` inventory against a grep of the migration files — zero missing).
- No duplicate seed rows in `workspace.metric_definitions` / `dimension_definitions` /
  `component_definitions` / `metric_sources`, `core.retail_calendar`; and no
  `metric_sources` row pair claiming `is_default` for the same `(metric_id, grain)`.
- Every `workspace.metric_sources` row points at a `source_view.source_column` that actually
  exists — verified by joining the catalog against `information_schema.columns`; **33/33 ok**.

**Weak:**

- `raw_logic.sales_transactions` has **no `NOT NULL`** on `branch_name`, `bill_date`,
  `bill_no`, `item_code`, `total_quantity`, `gross_amount` or `net_amount` — the views defend
  with `WHERE st.branch_name IS NOT NULL` and `COALESCE`, but `vw_sale_transactions_export`
  does not (C-13). 11 rows currently have `net_amount IS NULL`, 36 have `mrp IS NULL`.
- `raw_logic.stock_snapshot` has **no natural unique key** (only `PRIMARY KEY (id)`).
  6,526 `(branch_name, godown_name, item_code, size)` groups have >1 row (9,922 extra rows) —
  inspected, these all share one `upload_id` and one `loaded_at`, differing only in
  `closing_stock`, so they are the source report's own multi-line grain and the app's `SUM` is
  correct. But nothing structurally prevents a duplicated upload from doubling stock; the
  `DELETE`-then-insert in `fn_process_stock_upload` is the only protection.
- `raw_logic.sales_transactions` has no index supporting a date-range scan — `bill_date` is
  `text` (C-14) and the views compute `to_date()` per row. Fine at 24k rows; will not stay fine.
- 22 FK columns without an index (C-17).
- `core.stores` has only 4 rows and is seq-scanned 17,431 times (`pg_stat_user_tables`) — that
  is correct behaviour for a 4-row table, noted only to confirm it is not a missing-index
  problem.

---

## Migration status

There is **no migration-tracking table** for this project's own migrations (`auth.schema_migrations`,
`storage.migrations` and `realtime.schema_migrations` are Supabase's own). Applied state was
therefore established by checking that each migration's objects exist.

| Migration | Applied? | Evidence |
|---|---|---|
| 0000–0081 | **Yes** | all 32 migration-created views present; `core.*` / `ops.*` / `workspace.*` tables and the 23 `core`/`ops` functions all present |
| `0082_semantic_layer_verticals_and_grains.sql` | **Yes** | `workspace.dimension_definitions` = 15 rows, `component_definitions` = 25 rows, `metric_sources` seeded |
| `0083_fix_discount_value_weekly_source.sql` | **Yes** | `metric_sources('discount_value','weekly') → sales.vw_ebo_sales_weekly.discount, is_default=false` present |
| `0084_stock_view_mrp.sql` | **Yes** | `vw_stock_with_scheme` exposes `mrp` |
| `0085` / `0086` (export item attrs + bill_type fix) | **Yes** | `vw_sale_transactions_export` carries `im.item_name/season/gender/size_group/mrp/size` and the `SB-`/`RB-`/`OTHER` `bill_type` CASE |
| `0087_item_master_size_column.sql` | **Yes** | `raw_logic.item_master.size` exists |
| `0088_master_upload_batched_commit.sql` | **Yes** | `ops.fn_process_master_upload(uuid, jsonb, text, boolean)` — 4-arg signature live, old 3-arg gone |
| `0089_sale_upload_batched_commit.sql` | **Yes** | `ops.fn_process_sale_upload(uuid, jsonb, boolean)` — 3-arg signature live |
| `0090_sale_detail_sync.sql` | **Yes** | `ops.fn_upsert_synced_sale_rows`, `ops.fn_log_sale_detail_sync_run`, `ops.fn_sale_detail_sync_runs`, table `raw_logic.sale_detail_sync_runs` (5 rows) all present |
| `0091_bo002_bo004_stores.sql` | **Yes** | `core.stores` holds BO-002 and BO-004, both `is_active = false`, `created_at 2026-08-26 11:42:51` |
| `0092_ebo_sale_attribute_lines.sql` | **Yes** | `sales.vw_ebo_sale_attribute_lines` present, 22,344 rows |
| **`0093_fix_synced_return_sign.sql`** | **NO** | **227 sync RETURN rows still positive on all three fields — the migration's own "AFTER" assertion would fail** |

**No migration is in the folder but diverged in the DB** — every live view definition matches
the shape its migration creates.

**Non-idempotent migrations** (would break or duplicate on a re-run from scratch; none is a
problem for the current DB, which is already at 0092):

- `create table` without `if not exists`: `0002, 0003, 0004, 0006, 0007, 0008, 0009, 0010, 0018,
  0020, 0021, 0022, 0024, 0026, 0032, 0035, 0047, 0048, 0049, 0052` (20 files).
- `insert` without `on conflict`: `0003` (1), `0008` (1), `0024` (1 of 3), `0052` (3),
  `0068` (1), `0079` (3 of 5), `0082` (1 of 5).
- `HANDOFF.md:44-52` already records two ordering/permission exceptions found when applying
  from scratch (`0027` must run after `0029`/`0030`; `0045`'s `alter role service_role
  bypassrls` needs real superuser and must be skipped on Supabase). Those are still true.

`0093` itself is fully idempotent and re-runnable (see Part 1).

### `0092_ebo_sale_attribute_lines.sql` — close read

Applied and correct. The view's `COALESCE(NULLIF(TRIM(st.x), ''), NULLIF(TRIM(im.x), ''))`
pattern prefers the **transaction row's** attribute and falls back to `item_master` — the right
precedence, since the transaction captures the attribute as it was at sale time. Verified live:
zero NULLs on season / market_segment / category / subcategory / gender / size_group /
shade_name / mrp in both the Excel era (17,587 rows) and the sync era (4,757 rows). It shares
the `bill_type` `LIKE` derivation and the `is_active` store join with `vw_ebo_sales_lines`, so
it stays consistent with the rest of the chain. Its one consumer
(`app/(ho)/sales/page.tsx:558`) paginates correctly. **No finding.**

### `0091_bo002_bo004_stores.sql` — close read

Applied and correct: a plain `insert … on conflict (store_id) do nothing` with
`is_active = false` for both rows. Idempotent. The consequence it creates (BO-004's 1,631 rows
becoming invisible to every `vw_ebo_*` view, while remaining visible in
`vw_sale_transactions_export`) is deliberate and documented in the migration header — captured
as C-10 rather than as a defect.

---

## VERIFIED CORRECT

Things checked in detail that are right, so nobody re-checks them:

1. **The sign-handling code path** (all 16 steps in Part 1's trace). Post-`014b1c5` there is
   exactly one sign application, at the ERP source, and value and quantity are handled
   identically everywhere.
2. **Migration `0093` itself** — idempotent (`-abs()`), covers net + gross + **qty**,
   scope-guarded to sync rows. No edit needed before running it.
3. **No JOIN fan-out anywhere in the sales chain.** `item_master` and `scheme_lookup` are both
   `PRIMARY KEY (item_code)` with 0 duplicates; `vw_item_subcategory_lookup` has 0 duplicate
   `item_code`; `ebo_footfall_daily` has `UNIQUE (store_id, date)`; `dominant_scheme` is
   `DISTINCT ON` its join key. No `SUM` over a joined table is inflated.
4. **`COUNT(*)` vs `COUNT(DISTINCT)` is right in every view**: `count(DISTINCT bill_no)` where
   the source is line-grain (`vw_ebo_agent_daily`, `vw_ebo_sales_hourly`), plain `count(*)`
   where the source is already bill-grain (`vw_ebo_scheme_daily`, `vw_ebo_sales_daily`).
5. **No missing `COALESCE` in the aggregation chain.** `vw_ebo_sales_daily` COALESCEs all six
   measures to 0 against its calendar spine (so a zero-sales day is 0, not a missing row), and
   deliberately leaves the ratio metrics NULL via `NULLIF` denominators. (The one real gap is
   `vw_sale_transactions_export.discount_amount`, C-13.)
6. **No integer division, no float money.** Every money/qty column is `numeric`; every
   percentage multiplies by the numeric literal `100.0`; every division is guarded by `NULLIF`
   or an explicit `> 0` / `= 0` branch.
7. **Fiscal-year derivation** in `vw_sale_transactions_export` — `month >= 4 → FYyyyy-(yy+1)`,
   else `FY(yyyy-1)-yy`. Correct Apr–Mar boundary, correct 2-digit `lpad`.
8. **`gross`/`net` semantics agree across both data sources** — 37.67% (sync) vs 37.45%
   (Excel) realised discount, and `gross ≈ mrp × qty` to within 0.1% on both. The sync's field
   mapping is right.
9. **No duplicate bills.** `select bill_no, count(distinct branch_name||'|'||bill_date) …
   having count(…) > 1` returns **0 rows** — no bill number appears under two dates or two
   branches. Only 9 `(branch, date, bill, item)` groups have more than one `line_seq`, and 8 of
   those are genuine repeated item lines within one bill from one source (the 9th is C-06).
10. **Both upload commit paths are idempotent** on re-run of the same file:
    `fn_process_master_upload` and `fn_process_sale_upload` upsert on a real key;
    `fn_process_stock_upload` full-replaces.
11. **The "exactly 1000 rows" months are a coincidence, not truncation.** Excel rows for
    2025-11 and 2026-03 both total exactly 1,000, which looks like the PostgREST cap — but the
    per-branch split is 513+487 and 412+588 respectively, and both months run to the true month
    end (`2025-11-30`, `2026-03-31`). No upload was truncated.
12. **Timezone is not the cause of the ERP mismatch** — every business date is a `date` parsed
    from the ERP's own local-date text. See the Timezone analysis.
13. **`ops.vw_monthly_fresh_disc_audit_lines`' bucketing is sign-safe** — the
    `discount_amount / gross_amount` ratio stays positive on a negative RETURN row, and the
    `gross_amount = 0` case is branched before the division.
14. **All 33 `workspace.metric_sources` rows point at a real column** on a real view.
15. **All 32 migration-created views exist in the live database**; no drift between the
    migration files and `pg_get_viewdef`.

---

## UNVERIFIED

Suspicions I could not settle, each with the exact query or check that would settle it.
**None of these is claimed as a bug.**

1. **Does the ERP's `sale_detail` source itself agree with the Sale Register report the user
   reconciles against?** The whole sign fix rests on `signed_*` columns from a second Supabase
   project I do not have credentials to query independently. Settle with, against the ERP
   project: `select bill_type, count(*), sum(signed_quantity), sum(signed_net_amount) from
   sale_detail where fin_year = '2627' and branch_name = 'BO-001 - PUNE - UNDRI' and bill_date
   between '2026-08-01' and '2026-08-25' group by 1;` and compare to the ERP's own export.

2. **Is `line_seq` genuinely stable across sync runs?** The route derives it in fetch order
   (`route.ts:157-160`) and claims the `.order()` chain
   (`fin_year, vouch_code, barcode, sold_mrp, bill_type`) is a total order. If two
   `sale_detail` rows tie on all five, Postgres may return them in a different order between
   runs and the upsert would then write a *different* row for the same `line_seq`. Settle with,
   against the ERP project: `select fin_year, vouch_code, barcode, sold_mrp, bill_type,
   count(*) from sale_detail where fin_year >= '2627' group by 1,2,3,4,5 having count(*) > 1
   limit 20;` — if that returns rows, the ordering is not total.

3. **How many rows does a real PostgREST request actually return for the C-03 sites?** I proved
   the row counts exceed 1000 via psql, and the cap is documented in
   `lib/data/client.ts:76-88` as confirmed live on this project — but I did not re-confirm the
   project's current "Max Rows" setting myself. Settle with:
   `curl -s -I -H "apikey: $ANON" -H "Range: 0-99999" "$SUPABASE_URL/rest/v1/vw_stock_with_scheme?select=id" | grep -i content-range`
   — a `Content-Range` ending in `/…` with a first segment of `0-999` confirms the cap.

4. **Whether the `sale_detail` source has a `size_group` / `pack_size` column the sync could be
   fetching.** The sync's `.select()` (`route.ts:137`) omits both; `pack_size` is consequently
   NULL on 567 FY26-27 attribute rows. Settle with, against the ERP project:
   `select * from sale_detail limit 1;` and look for the columns.

5. **Whether the 3,315 un-enriched Uniware orders (C-05) are a backlog that will clear or a
   permanent gap.** Settle by running `/api/cron/uniware-sync` to completion and re-checking
   `select count(*) filter (where items_synced_at is null) from raw_uniware.sale_orders;`.

6. **Whether `raw_logic.stock_snapshot`'s 9,922 same-key rows are genuinely the source
   report's own grain.** They share one `upload_id`, one `loaded_at`, and differ only in
   `closing_stock`, which is consistent with a multi-line source report — but I cannot see the
   original workbook. Settle by opening the stock XLSX for upload
   `a537fc62-9823-42a8-882e-33ba69fa7962` and checking whether item `8905385000527`, godown
   `ECOM FG`, size 22 appears twice with `closing_stock` 5 and 2.
