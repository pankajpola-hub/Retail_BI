# Audit B — API, Auth, RBAC & Security

- **Date:** 2026-08-27
- **Commit SHA:** `014b1c533ae877002bf92a8204efa7590d8ad299` (branch `master`)
- **Routes reviewed:** 22 / 22 (every `route.ts` under `web/app/api/`)
- **Method:** full read of each route handler, `web/lib/auth`, `web/lib/permit`, `web/lib/scope`, `web/lib/data`, `web/lib/storage`, `web/lib/supabase`, `web/middleware.ts`, `web/vercel.json`, migrations `0022/0079/0080/0081/0073/0074`, plus read-only `psql` queries against the live Supabase Postgres (`raw_uniware.sync_runs`, `raw_logic.sale_detail_sync_runs`, `pg_policy`, `storage.buckets`, `information_schema.role_table_grants`).
- **No source file was modified.** Only this report was written.

---

## Summary table

| ID | Severity | Route/Area | One-line | Confidence |
|----|----------|------------|----------|------------|
| B-01 | **P0** | `cron/sale-detail-sync` + `web/vercel.json` | Route is **not** in the `crons` array — it has never run on a schedule; the only successful run ever was a manual one on 26 Aug 2026, so current-FY sales data is frozen. | Certain (DB + file proof) |
| B-02 | **P0** | `raw_logic.sales_transactions` (FY26-27 rows) | The 4,757 synced FY26-27 rows were written by the **pre-fix** `Math.abs()` code — 227 returns stored positive; live FY26-27 net is overstated by **+11.2%**. The sign fix (commit `014b1c5`, 11:36 IST today) has not been re-run. | Certain (DB proof) |
| B-03 | **P1** | `data-upload/download-merged` | Uses a bare `.limit(200_000)` on `vw_sale_transactions_export`; PostgREST "Max Rows" silently caps at 1000 — the "full merged history" export returns at most 1000 rows with no error. | High (code + repo's own live-confirmed note on the same view) |
| B-04 | **P1** | `data-upload/upload-url` | No role check. Any authenticated user (marketing, ebo_manager, …) gets a service-role-minted signed upload URL into the `erp-reports` bucket. The route's own comment asserts the opposite. | Certain (code proof) |
| B-05 | **P1** | `sales-source/sale-detail` | Only "is signed in". Any authenticated user of any role gets network-wide revenue totals + full-view scan of the ERP source project. | Certain (code proof) |
| B-06 | **P2** | `targets/upload` | No role check before the service-role storage write. A non-admin can write files into the `incentive-targets` bucket; the DB row then fails RLS, leaving an orphaned object with no cleanup. | Certain (code + RLS proof) |
| B-07 | **P2** | All 5 `cron/*` routes | `CRON_SECRET` unset ⇒ comparison becomes the literal string `Bearer undefined`, which an attacker can send. No fail-closed guard. | Certain (code proof) |
| B-08 | **P2** | `web/lib/uniware/client.ts` | No timeout / no `AbortController` / no retry on any of the three outbound Uniware `fetch` calls. | Certain (grep proof) |
| B-09 | **P2** | `targets/monthly/bulk-preview` | No role check; leaks the full store list and every existing monthly target for arbitrary store/month keys to any authenticated user. | Certain (code proof) |
| B-10 | **P3** | `sales-source/sale-detail` | Returns upstream `code`/`details`/`hint`/`status` from the second Supabase project verbatim in the 500 body. | Certain (code proof) |
| B-11 | **P3** | `targets/monthly/template` | No role check — leaks `core.stores.store_name` to any authenticated user. | Certain (code proof) |
| B-12 | **P3** | `data-upload/download/[id]` | `Content-Disposition` filename built from DB `file_name` stripping only `"` — CR/LF not stripped. | High (code proof; exploitability unverified) |
| B-13 | **P3** | `lib/alerts/mailer.ts` | nodemailer transport has no `connectionTimeout`/`socketTimeout`/`greetingTimeout`. | Certain (code proof) |
| B-14 | **P3** | All API routes | No rate limiting or request-size limiting anywhere in `web/app/api/`. | Certain (absence verified) |

---

## Endpoint matrix

Legend — **Auth?**: what proves identity. **AuthZ?**: what restricts *which* identities. `RLS-only` = the route itself does no role check and relies entirely on a Postgres policy.

| Route | Method | Auth? | AuthZ? | Validation? | IDOR risk | Notes |
|---|---|---|---|---|---|---|
| `cron/alerts` | GET | `CRON_SECRET` bearer, `route.ts:18-21` | n/a (secret is the authz) | none needed | none | service-role client; sends email |
| `cron/sale-detail-sync` | GET | `CRON_SECRET` bearer, `route.ts:120-123` | n/a | none needed | none | **not in `vercel.json`** — see B-01 |
| `cron/scheduled-exports` | GET | `CRON_SECRET` bearer, `route.ts:22-25` | n/a | none needed | none | service-role; sends email |
| `cron/uniware-sync` | GET | `CRON_SECRET` bearer, `route.ts:118-121` | n/a | none needed | none | registered `0 3 * * *`; running clean |
| `cron/uniware-sync/status` | GET | `CRON_SECRET` bearer, `route.ts:35-38` | n/a | `limit` coerced + clamped to 100, `route.ts:41-42` | none | good input handling |
| `data-upload/download-merged` | GET | session `getUser()`, `route.ts:72-77` | **role list** `ho_admin`/`super_admin`, `route.ts:46,86-91` | `fy` split, passed to `.in()` (parameterised) | none | B-03: 1000-row silent truncation |
| `data-upload/download/[id]` | GET | session, `route.ts:29-34` | RLS-only (`erp_report_uploads_rw`) | none on `id` | **low** — `id` goes to `.eq()`; RLS is role-scoped, not owner-scoped, so any `ho_admin` reads any upload (acceptable single-tenant) | B-12 header echo |
| `data-upload/process/[id]/commit` | POST | session, `route.ts:45-50` | RLS-only + SECURITY DEFINER role check inside `ops.fn_process_sale_upload` | `offset`/`batchSize` typeof+range checked, `route.ts:91-92`; **no zod** | same as above | Idempotent: re-parses the file server-side, never trusts client rows (`route.ts:30-34`); upsert on natural key |
| `data-upload/process/[id]/preview` | POST | session, `route.ts:32-37` | RLS-only | none (no body) | same as above | read-only |
| `data-upload/register` | POST | session, `route.ts:22-27` | RLS-only | manual: enum check `:34`, presence `:40`, **path-prefix bound to caller's own `user.id`** `:51` | none | Good — the `storagePath.startsWith(\`${reportType}/${user.id}/\`)` check is correct |
| `data-upload/upload-url` | POST | session, `route.ts:45-50` | **NONE** | manual: enum `:58`, size `:67`, MIME allow-list `:70` (all client-*claimed*) | n/a | **B-04** — service-role signed upload URL for any authenticated user |
| `footfall` | POST | session, `route.ts:37-45` | RLS-only (`footfall_write` / `footfall_update`) | **zod** `route.ts:7-17` | none | 42501 mapped to a clean 403 `:117-128` — good |
| `footfall/download` | GET | session, `route.ts:34-38` | **role list** `:24,49-54` **AND** store-scope via `core.fn_user_store_ids()` `:71-76` | ISO-date regex `:63-69` | none | Best-in-repo pattern |
| `replenishment/download` | GET | session, `route.ts:21-26` | **role list** `:29-31` **AND** two `resolveAccess()` feature keys `:40-50` | `parseAssumptions(searchParams)` | none | Only route enforcing 0079 feature gates server-side |
| `sales-source/sale-detail` | GET | session, `route.ts:28-33` | **NONE** | none (no params) | n/a | **B-05**, **B-10**; full-view scan, unbounded |
| `targets/monthly` | POST | session, `route.ts:47-55` | RLS-only (`monthly_targets_write/update` = ho/super) | **zod** `:20-30` | none | 409 confirm-overwrite flow |
| `targets/monthly/audit-report` | GET | session, `route.ts:59-64` | **role list** `ho_admin`/`regional_manager`/`super_admin` `:49,77` | store/month params | none | Keyset-paginates (`line_id`) — correctly avoids the B-03 trap |
| `targets/monthly/bulk-commit` | POST | session, `route.ts:41-46` | RLS-only | **zod** `:14-25`, `.min(1)` | none | **No max array length** — unbounded batch |
| `targets/monthly/bulk-preview` | POST | session, `route.ts:25-30` | **NONE** | `file instanceof File` `:34`; **no size cap, no MIME check** | n/a | **B-09** |
| `targets/monthly/template` | GET | session, `route.ts:16-21` | **NONE** | none | n/a | **B-11** |
| `targets/remarks` | POST | session, `route.ts:40-48` | RLS-only (store-scoped) | **zod** `:23-28`, `max(2000)` | none | Correct division of labour |
| `targets/upload` | POST | session, `route.ts:20-25` | **NONE** for the storage write; RLS only on the DB row `:54-57` | size `:33`, MIME `:36` (real `File`, so trustworthy) | n/a | **B-06** |

---

## Findings

### B-01 — [P0] `cron/sale-detail-sync` is not scheduled; current-FY sales data is frozen

**Where**
`web/vercel.json` (whole file) and `web/app/api/cron/sale-detail-sync/route.ts`.

**Proof**

`web/vercel.json` — the complete file:

```json
{
  "crons": [
    { "path": "/api/cron/uniware-sync",      "schedule": "0 3 * * *" },
    { "path": "/api/cron/scheduled-exports", "schedule": "0 4 * * *" },
    { "path": "/api/cron/alerts",            "schedule": "0 7 * * *" }
  ]
}
```

`/api/cron/sale-detail-sync` is absent. The route's own header acknowledges it (`route.ts:92-95`):

```
 * Vercel Cron target — see vercel.json's schedule (added once the manual
 * parity check in the plan passes, per Pankaj's own rollout requirement).
```

Live DB, `raw_logic.sale_detail_sync_runs`, every row that exists:

```
5 | 2026-08-26 12:10:20+00 | 2026-08-26 12:10:31+00 | 20262027 | 4756 | []                                                          | t
4 | 2026-08-26 12:07:13+00 | 2026-08-26 12:07:14+00 | 20262027 |    0 | ["query: permission denied for table sale_header_state ..."] | f
3 | 2026-08-26 12:05:21+00 | 2026-08-26 12:05:21+00 | 20262027 |    0 | ["sign_in: Invalid API key"]                                 | f
2 | 2026-08-26 11:59:51+00 | 2026-08-26 11:59:51+00 | 20262027 |    0 | ["SALES_SUPABASE_URL / ... are not set."]                    | f
1 | 2026-08-26 11:50:57+00 | 2026-08-26 11:50:57+00 | 20262027 |    0 | ["SALES_SUPABASE_URL / ... are not set."]                    | f
```

Five runs total, four failures, **one** success at 2026-08-26 12:10 UTC = 17:40 IST — exactly the manual run described in the task brief. Nothing since.

Freshness of the data itself:

```
select max(to_date(bill_date,'DD/MM/YYYY')), count(*) from raw_logic.sales_transactions;
-> 2026-08-26 | 24010
```

**Impact.** Every current-FY figure in the app (Sales, Targets, Network, Replenishment) stops advancing the day after the last manual sync. There is no alert on this: no consumer reads `sale_detail_sync_runs`, and the `/api/cron/uniware-sync/status` health endpoint covers only the *other* sync (`raw_uniware.sync_runs`, via `ops.fn_uniware_sync_runs`).

**Root cause.** Deliberate staging decision ("add the cron entry once parity passes") that was never followed through after parity passed.

**Recommended fix.** Add `{ "path": "/api/cron/sale-detail-sync", "schedule": "0 2 * * *" }` to `web/vercel.json`'s `crons`, redeploy, then extend `/api/cron/uniware-sync/status` (or add a sibling) to report `raw_logic.sale_detail_sync_runs` so a silent stall is visible.

**Correction to the prior audit run's claim.** `vercel.json` *does* exist and *does* have a `crons` array; `/api/cron/uniware-sync` **is** registered and is running cleanly nightly — `raw_uniware.sync_runs` shows success every day 23–27 Aug with zero errors (the two failures were on 22 Aug during setup). Only `sale-detail-sync` is unregistered. The "4 failures then 1 manual success" detail is correct, but it belongs to `sale-detail-sync`, not `uniware-sync`.

---

### B-02 — [P0] FY26-27 synced rows still carry the pre-fix unsigned magnitudes

**Where** `web/app/api/cron/sale-detail-sync/route.ts:87-90` (`toSigned`, the *fixed* version) vs. the rows already in the database.

**Proof.** The fix landed today:

```
$ git log -1 --format="%ci %s" 014b1c5
2026-08-27 11:36:29 +0530 Fix RETURN sign convention — Sales/Targets were ~8% too high
```

The only sync run that ever wrote rows finished 2026-08-26 12:10 UTC — **before** that commit, i.e. while `toUnsigned()`/`Math.abs()` was still in place. The database confirms the damage:

```
select count(*) filter (where net_amount < 0) as neg, count(*)
  from raw_logic.sales_transactions
 where to_date(bill_date,'DD/MM/YYYY') >= '2026-04-01';
-> 0 | 4757
```

Zero negative rows out of 4,757 in FY26-27 — every return is stored as a positive magnitude, so the reporting chain (`sales.vw_ebo_sales_lines` → `vw_ebo_bill` → `vw_ebo_sales_daily/_weekly/_monthly`, `vw_ebo_sale_attribute_lines`), which sums `net_amount` as stored, adds returns instead of subtracting them.

And there are real returns in that window — this is not a vacuously-true "no negatives because no returns":

```
select bill_type, count(*), sum(net_amount)
  from sales.vw_sale_transactions_export where financial_year='FY2026-27' group by 1;
-> RETURN | 227  |   279,199.00
-> SALE   | 4530 | 5,282,363.00
```

227 return lines totalling **+279,199** where they should be **−279,199**.

**Impact.** Quantified from the live data: reported FY26-27 net is 5,561,562 against a true 5,003,164 — an overstatement of 558,398, or **+11.2%**. Every current-FY figure in Sales, Targets, Network and Replenishment carries this error, and target attainment percentages inherit it directly. Matches the route header's own worked example (Undri 621,403 vs a true 585,315; quantity 501 vs 471).

**Root cause.** The code fix is correct but no re-sync has run since (see B-01 — nothing schedules one).

**Recommended fix.** Fix B-01 first, then trigger one manual authenticated invocation of `/api/cron/sale-detail-sync`. The upsert is idempotent on `(branch_name, bill_date, bill_no, item_code, line_seq)`, so a single re-run overwrites all 4,757 rows with correctly signed values. Verify afterwards that the `neg` count above is non-zero.

---

### B-03 — [P1] "Merged sale data" export is silently truncated to 1000 rows

**Where** `web/app/api/data-upload/download-merged/route.ts:54` and `:102-108`.

**Proof**

```ts
// route.ts:54
const EXPORT_ROW_LIMIT = 200_000;
...
// route.ts:102-108
const { data, error } = await query
  .order("bill_date") ... 
  .limit(EXPORT_ROW_LIMIT);
```

The repo's own shared client documents that this does not work, naming the very same view (`web/lib/data/client.ts`, the `range()` doc comment and `fetchAllRows`'s header):

> Supabase's project "Max Rows" API setting caps every PostgREST response at 1000 regardless of `.limit()` — confirmed live 2026-08-25 against `vw_stock_with_scheme`/`vw_sale_transactions_export` (a bare `.limit(40000)`/`.limit(100000)` both silently returned exactly 1000 rows, no error).

`download-merged` queries `sales.vw_sale_transactions_export` and never calls `fetchAllRows`/`.range()`. There are 24,010 rows in `raw_logic.sales_transactions`.

**Impact.** An HO admin downloads what is labelled the complete merged history and receives ~4% of it, with no error and no warning — the worst failure mode for a reconciliation artefact.

**Root cause.** The route predates the 2026-08-25 discovery of the Max-Rows cap and was not swept up in the `fetchAllRows` migration that fixed `lib/replenishment/compute.ts` and `mix.ts`. Note `targets/monthly/audit-report` avoids this correctly with its own keyset loop — the pattern exists, it just wasn't applied here.

**Recommended fix.** Replace the single `.limit()` with `fetchAllRows(() => …)` from `web/lib/data/client.ts`, rebuilding the full chain inside the callback (a builder is single-use once `.range()`'d).

---

### B-04 — [P1] `data-upload/upload-url` mints a service-role storage upload URL for any authenticated user

**Where** `web/app/api/data-upload/upload-url/route.ts:42-94`, and `web/lib/storage/supabase.ts:30-39`.

**Proof.** The route's entire access control:

```ts
// route.ts:45-50
const { data: { user } } = await supabase.auth.getUser();
if (!user) {
  return NextResponse.json({ ok: false, error: { code: "unauthorized", ... } }, { status: 401 });
}
```

There is no role query, no `resolveAccess()`, no RLS read that would fail for a non-admin. It then calls:

```ts
// route.ts:80
const { signedUrl, token } = await createUploadUrl("erp-reports", path);
```

and `createUploadUrl` uses the **service-role** client (`web/lib/storage/supabase.ts:35`: `const supabase = createAdminClient();`), which bypasses Storage policies entirely.

The route's own header (`:37-40`) asserts the opposite of what the code does:

> Acceptable: this whole surface is already ho_admin/super_admin only, not a public upload endpoint…

It is not. `/data-upload` the *page* is gated; this API route is not.

**Impact.** Any signed-in user of any role (`marketing`, `ebo_manager`, `regional_manager`) can obtain an unlimited number of signed upload URLs and write arbitrary bytes into the private `erp-reports` bucket. The `contentType`/`fileSize` checks at `:67-75` are the caller's own self-declared JSON values and constrain nothing about the subsequent direct PUT. The follow-up `register` call *is* blocked by RLS, so this is storage abuse / orphaned-object accumulation rather than data poisoning — but the bucket has no `file_size_limit` set at the bucket level either (`storage.buckets` shows `file_size_limit = NULL` for all three buckets).

**Root cause.** Role enforcement was assumed to be inherited from the page; the direct-to-Storage refactor (2026-08-25) moved the entry point to an API route without carrying the gate across.

**Recommended fix.** Add the same profile-role check `download-merged/route.ts:79-91` already uses (`ho_admin`/`super_admin`) before calling `createUploadUrl`, and set a bucket-level `file_size_limit` + `allowed_mime_types` on `erp-reports`.

---

### B-05 — [P1] `sales-source/sale-detail` exposes network-wide revenue to every authenticated user

**Where** `web/app/api/sales-source/sale-detail/route.ts:26-103`.

**Proof.** Complete access control (`:27-33`):

```ts
const appSupabase = await createAppClient();
const { data: { user } } = await appSupabase.auth.getUser();
if (!user) {
  return NextResponse.json({ ok: false, error: { code: "unauthorized", ... } }, { status: 401 });
}
```

No role check, no store scope, no `resolveAccess()`. It then returns (`:100-103`) `lineCount`, `distinctBills`, `unmatchedProductRows` and `revenue` — the last being `sum(signed_net_amount)` across the **entire** `sale_detail` view of the ERP source project, i.e. every store, every fiscal year present.

The route's own header even names the risk and then doesn't mitigate it:

> Gated behind THIS app's own session … since this queries and exposes real revenue-adjacent figures — a URL-only-knowledge bar is not enough, same posture as api/replenishment/download/route.ts.

`replenishment/download` does a role check **and** two feature-permission checks. This route does neither, so the cited "same posture" is not implemented.

**Impact.** A store-scoped `ebo_manager` or a `marketing` user — who by design sees only their own stores — gets whole-network revenue with one GET. Secondarily, `fetchAllSalesSourceRows` paginates the *entire* view on every call with no date bound (`:86-96`), so it is also an unauthenticated-in-practice DoS/cost lever against the second Supabase project.

**Root cause.** Diagnostic endpoint built during the sale_detail integration and left mounted in the production route tree.

**Recommended fix.** Either delete it, or gate it on `ho_admin`/`super_admin` using the `download-merged` pattern and bound the scan to the current fiscal year.

---

### B-06 — [P2] `targets/upload` writes to storage before any authorization check

**Where** `web/app/api/targets/upload/route.ts:17-60`.

**Proof.** Auth is "signed in" only (`:20-25`). The storage write happens first:

```ts
// route.ts:43-46
const path = `${user.id}/${Date.now()}-${file.name}`;
try {
  await saveObjectFile("incentive-targets", path, file);
```

`saveObjectFile` uses the service-role client (`web/lib/storage/supabase.ts:50`). Only afterwards is the DB row inserted (`:54-57`), and *that* is what RLS stops — confirmed live:

```
ops.incentive_target_imports | rowsecurity=t | incentive_target_imports_rw | cmd=* |
  (core.fn_user_role() = ANY (ARRAY['ho_admin','super_admin']))
```

So a non-admin's request writes the object, then gets a 400 `record_failed`, and the object is never removed — `removeObjectFile` is not called on this path.

**Impact.** Unauthorized writes into a private bucket plus unbounded orphaned-object growth. Bounded to 10MB of xlsx/xls per request (the checks at `:33-41` operate on a real `File`, so they are trustworthy here, unlike B-04's).

**Recommended fix.** Move a role check ahead of `saveObjectFile`, and add a `removeObjectFile` in the `recordError` branch as defence in depth.

---

### B-07 — [P2] `CRON_SECRET` comparison is not fail-closed

**Where** all five cron routes, identically:

- `cron/alerts/route.ts:19`
- `cron/sale-detail-sync/route.ts:121`
- `cron/scheduled-exports/route.ts:23`
- `cron/uniware-sync/route.ts:119`
- `cron/uniware-sync/status/route.ts:36`

**Proof**

```ts
const auth = request.headers.get("authorization");
if (auth !== `Bearer ${process.env.CRON_SECRET}`) { ... 401 ... }
```

If `CRON_SECRET` is unset in an environment (a new preview deployment, a renamed variable, a missed Vercel env entry), the template literal evaluates to the literal string `"Bearer undefined"`, which any caller can send. These routes then run with the **service-role** client: `uniware-sync` and `sale-detail-sync` write to `raw_logic`/`raw_uniware`, and `alerts`/`scheduled-exports` send email.

Also note the comparison is non-constant-time; for a high-entropy random secret over HTTPS this is theoretical, but it is a trivially cheap fix alongside the guard.

**Recommended fix.** Extract one shared helper that returns 500 when `process.env.CRON_SECRET` is falsy, and compares with `crypto.timingSafeEqual` on equal-length buffers.

---

### B-08 — [P2] Uniware HTTP calls have no timeout and no retry

**Where** `web/lib/uniware/client.ts:73`, `:325`, `:359`.

**Proof.** All three outbound calls are bare fetches:

```
73:  const res = await fetch(`${process.env.UNIWARE_BASE_URL}/services/soap/?version=1.9`, {
325: const res = await fetch(url.toString(), { method: "POST", cache: "no-store" });
359: const res = await fetch(`${process.env.UNIWARE_BASE_URL}${path}`, {
```

A grep for `timeout|AbortController|setTimeout|retry` across the file returns only these three `fetch(` lines — none of those constructs is present.

**Impact.** `cron/uniware-sync` makes up to ~7 sequential `SearchSaleOrder` pages + 20 `GetSaleOrder` + 20 `GetReturn` calls per invocation against an India-hosted tenant from a US datacenter, inside a hard 60s Vercel ceiling. One hung socket consumes the entire budget and the invocation dies with `FUNCTION_INVOCATION_TIMEOUT` — which is precisely the failure the batch sizes were repeatedly cut (150→60→20) to work around. The route's per-phase try/catch cannot help, because the whole function is killed by the platform, not by a thrown error.

**Failure surfacing:** *partially* good. Errors are collected into `errors[]` and persisted via `ops.fn_log_uniware_sync_run` (`route.ts:300-313`), readable through `/api/cron/uniware-sync/status`. But a platform timeout kills the process *before* that log write, so the worst failure mode leaves no row at all — an invisible gap rather than a recorded failure.

**Recommended fix.** Give every Uniware fetch an `AbortSignal.timeout(8000)` and a single retry on network error, and write a "started" row up front so a killed invocation is detectable as a run with no `finished_at`.

---

### B-09 — [P2] `targets/monthly/bulk-preview` has no role check and no file limits

**Where** `web/app/api/targets/monthly/bulk-preview/route.ts:23-89`.

**Proof.** Auth is "signed in" only (`:25-30`). There is no role check anywhere in the file. It then reads the whole store list (`:41`) and, for arbitrary caller-controlled `(storeId, month)` keys parsed out of the uploaded workbook, queries existing targets (`:71-76`):

```ts
.from<EboMonthlyTargetRow>("ebo_monthly_targets")
.select("store_id, period_month, fresh_target_qty, discounted_target_qty, updated_at")
.in("store_id", storeIds)
.in("period_month", periodMonths);
```

`ops.ebo_monthly_targets`'s read policy is `monthly_targets_read: (store_id = ANY (core.fn_user_store_ids()))`, so RLS *does* bound the target rows to the caller's own stores — the leak is the **store directory** (`core.stores`, which has no such scoping in this query) and confirmation of which of the caller's own months are set, to roles that have no business on the targets-upload flow.

Separately: `file` is accepted with no size cap and no MIME check (`:32-39`) — only `bulk-preview` and no other upload route lacks both. `file.arrayBuffer()` at `:42` loads it fully into memory before `parseMonthlyTargetsWorkbook`.

**Recommended fix.** Add the `ho_admin`/`super_admin` role check that `bulk-commit`'s RLS implies, plus the same `MAX_BYTES`/`ALLOWED_TYPES` pair used by `targets/upload/route.ts:5-9`.

---

### B-10 — [P3] `sales-source/sale-detail` leaks upstream error internals

**Where** `web/app/api/sales-source/sale-detail/route.ts:114-129`.

**Proof**

```ts
error: {
  code: "sales_source_query_failed",
  message: err instanceof Error ? err.message : "Query failed.",
  phase:      isSalesSourceError ? err.phase   : undefined,
  sourceCode: isSalesSourceError ? err.code    : undefined,
  details:    isSalesSourceError ? err.details : undefined,
  hint:       isSalesSourceError ? err.hint    : undefined,
  status:     isSalesSourceError ? err.status  : undefined,
}
```

PostgREST `hint` fields are exactly the kind that name internal objects — the DB already holds a recorded example of one: `"query: permission denied for table sale_header_state (hint: Grant the required privileges to the current role with: GRANT SELECT ON public.sale_header_state TO authenticated;)"` (`raw_logic.sale_detail_sync_runs` row 4). That string would be returned to the browser by this route.

No stack traces are returned anywhere in the API (`err.stack` appears in no route response), and no connection string is ever echoed — this is the only route that forwards structured upstream error metadata.

**Recommended fix.** Log the detail server-side (it already does, `:112`) and return only `code` + a generic message. Combine with B-05's role gate.

---

### B-11 — [P3] `targets/monthly/template` leaks store names to any authenticated user

**Where** `web/app/api/targets/monthly/template/route.ts:14-24`. Auth is "signed in" only; `:23` selects `core.stores.store_name` and embeds the first one in the generated workbook. Low impact (store names are not secret), listed for completeness of the authz sweep.

---

### B-12 — [P3] Unsanitised `Content-Disposition` filename

**Where** `web/app/api/data-upload/download/[id]/route.ts:60`.

```ts
"Content-Disposition": `attachment; filename="${upload.file_name.replace(/"/g, "")}"`,
```

Only the double-quote is stripped. `file_name` originates from client JSON in `data-upload/register/route.ts:31` (`const fileName = body?.fileName;`), validated at `:40` only as a non-empty string — CR, LF and `;` all pass. Undici/Next will most likely reject a header value containing CRLF at the runtime level, which is why this is P3 and not higher; the *unverified* part is whether that rejection actually holds on Vercel's runtime (see UNVERIFIED). Note `footfall/download` and `download-merged` build their filenames from server-side values, so this is the only affected route.

**Recommended fix.** `upload.file_name.replace(/[^\w.\- ]/g, "_")`, or use the RFC 5987 `filename*=UTF-8''…` form.

---

### B-13 — [P3] SMTP transport has no timeouts

**Where** `web/lib/alerts/mailer.ts:26-32`.

```ts
return nodemailer.createTransport({
  host, port: Number(port), secure: false, requireTLS: true,
  auth: { user, pass },
});
```

No `connectionTimeout`, `greetingTimeout` or `socketTimeout`. Called from `cron/alerts` and `cron/scheduled-exports`, both `maxDuration = 60`. A stalled Gmail connection burns the whole invocation. Failure *is* surfaced — `runDueAlerts`'s errors are collected into the response `errors[]` (`cron/alerts/route.ts:28-36`) — but only to whoever reads that response, which for a scheduled Vercel cron is nobody.

---

### B-14 — [P3] No rate limiting or request-size limiting

No middleware, no per-route limiter, and no `@upstash/ratelimit`-class dependency exists in `web/package.json`. `targets/monthly/bulk-commit`'s zod array has `.min(1)` but **no `.max()`** (`route.ts:15-24`), so a single request can carry an arbitrarily large upsert payload. Combined with B-04 (unauthenticated-in-practice storage URL minting) this is worth a baseline limiter on the `data-upload/*` and `targets/*` families.

---

## Secrets & credentials (values REDACTED, rotation advice)

**Nothing is committed to git.** Verified:

- `git ls-files | grep -i env` → only `web/next-env.d.ts` (a TypeScript declaration file, no secrets).
- `git log --all --diff-filter=A --name-only | grep -iE "\.env"` → **empty**. No `.env` file has ever been added in any commit on any branch.
- `.gitignore:21-23` covers `.env`, `.env.local`, `.env.*.local`; `web/.gitignore:4,16` covers `.env*`.
- Grep across `web/app`, `web/lib`, `server`, `scripts` for `sk_`, `eyJhbGciOi`, `BEGIN RSA`, inline `password: "…"` → zero hardcoded credentials. The only hits were prose in comments and i18n UI labels (`web/lib/i18n/translations.ts:165` `password: "Password"`).

**Nothing reaches the client.** Verified:

- `grep -rln '"use client"' … | xargs grep -ln "process.env"` → **empty**. No client component reads `process.env` at all.
- Only two `NEXT_PUBLIC_*` variables exist (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`), read only in `web/lib/supabase/{server,middleware,admin}.ts` and echoed once in `data-upload/upload-url/route.ts:92`. Echoing the anon key there is correct — it is public by definition and is Storage's required `apikey` header on the browser's direct PUT.
- `web/lib/salesSource/client.ts:9` explicitly documents that `SALES_*` is deliberately **not** `NEXT_PUBLIC_`.

**Credentials present in `web/.env.local` (untracked, local dev machine only).** Names only, all values redacted:

| Variable | Assessment |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Highest-value secret in the repo. Server-only. See RLS section. |
| `SUPABASE_DB_URL` | Direct Postgres superuser-class connection string. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_PROJECT_ID` | Public by design. |
| `CRON_SECRET` | Sole gate on 5 service-role routes. See B-07. |
| `PERMIT_API_KEY` | Permit.io **Development** environment key (per its own comment). Shadow-mode only. |
| `UNIWARE_SEARCH_API_KEY`, `UNIWARE_GETORDER_API_KEY` (+ usernames) | Per-operation Uniware API keys — correct practice. |
| `UNIWARE_REST_USERNAME` / `UNIWARE_REST_PASSWORD` | **A personal Uniware portal login, not a service account** — the file's own comment says so. **Rotate to a dedicated REST service account.** |
| `SALES_USER_EMAIL` / `SALES_USER_PASSWORD` | A real end-user login to the second Supabase project, used by `getSalesSourceClient()` via `signInWithPassword` (`web/lib/salesSource/client.ts:92-96`). **Same problem — should be a service identity, not a person's password.** |
| `SMTP_USER` / `SMTP_PASSWORD` | Gmail app-password (not the account password) — acceptable. Shared with an unrelated project (`D:\Py\Shopify image uploader`), so blast radius spans two systems. |
| `INTEGRATION_SECRET_KEY` | Passphrase for `core.fn_save_logic_erp_credentials` / `fn_decrypt_logic_erp_password` (migration 0021). Losing/rotating it orphans stored ERP credentials — see 0021's own header. |
| `SELFHOSTED_KEYCLOAK_*`, `SELFHOSTED_MINIO_*`, `SELFHOSTED_POSTGREST_URL` | Retired local-only stack (localhost). Low value. **Recommend deleting the block** — dead credentials in a live env file are a liability with no upside. |
| `VERCEL_OIDC_TOKEN` | Vercel CLI artefact, short-lived. |

**Rotation advice, in priority order:**

1. `UNIWARE_REST_PASSWORD` — replace the personal login with a dedicated Uniware REST service account.
2. `SALES_USER_PASSWORD` — replace with a service identity on the sales-source Supabase project, scoped read-only to `sale_detail`.
3. Delete the entire `SELFHOSTED_*` block.
4. Confirm `CRON_SECRET` is set in **every** Vercel environment (Production, Preview, Development) — B-07 makes an unset value an auth bypass, and Preview deployments are the likely gap.

---

## RLS & service-role analysis

**RLS is real and is the primary authorization boundary.** The design is explicit about this — `web/lib/auth/access.ts:36-39`:

> NOT A SECURITY BOUNDARY. This tailors what a page renders. The real boundary is Postgres RLS + core.fn_user_store_ids() … a wrong feature toggle means someone sees a table they didn't need, never another store's data.

Verified live against `pg_policy` — every table an API route writes has RLS enabled with a meaningful predicate:

| Table | RLS | Policy predicate (live) |
|---|---|---|
| `ops.erp_report_uploads` | on | `USING`/`WITH CHECK`: `core.fn_user_role() = ANY('{ho_admin,super_admin}')` |
| `ops.incentive_target_imports` | on | same |
| `ops.ebo_monthly_targets` | on | read: `store_id = ANY(core.fn_user_store_ids())`; insert/update: role in `{ho_admin,super_admin}` |
| `ops.daily_target_remarks` | on | read/update/insert: `store_id = ANY(core.fn_user_store_ids())` |
| `ops.ebo_footfall_daily` | on | read: store-scoped; write: store-scoped **AND** role-list **AND** `date >= CURRENT_DATE - 7` unless ho/super |
| `core.role_permissions`, `core.feature_keys`, `core.user_permission_overrides`, `core.admin_audit_log` | on | policies at `0079_permission_system.sql:252-281`; `admin_audit_log` append-only (no update/delete grant to any role, `:112`) |

`raw_logic.sales_transactions` and `raw_logic.sale_detail_sync_runs` have **RLS off**, which is correct here because the schema is not reachable by end users: `information_schema.role_table_grants` for `table_schema='raw_logic'` and grantee in (`authenticated`,`anon`,`PUBLIC`) returns exactly **one** row — `scheme_lookup | authenticated | SELECT` (granted deliberately by `0075_grant_scheme_lookup.sql`). Everything else in `raw_logic` is reachable only through `SECURITY DEFINER` functions or the service-role client.

**Which key is used where.**

- **Anon key + user session (RLS applies)** — `web/lib/supabase/server.ts` → `web/lib/data/client.ts::createClient()`. This is what **17 of 22** routes use. Correct.
- **Service-role key (RLS bypassed)** — `web/lib/supabase/admin.ts` → `web/lib/data/admin.ts::createAdminClient()`. `lib/data/admin.ts:5-12` declares a deliberately restricted import list. Actual importers, verified by grep:
  - `app/(admin)/users/actions.ts`, `app/(admin)/integrations/*`, `app/(configurations)/configurations/*` — server actions behind admin pages.
  - **All 5 `api/cron/*` routes** — gated by `CRON_SECRET`, and **none of them takes user input**: `sale-detail-sync` and `uniware-sync` take no parameters at all; `status` takes `limit`, which is `Number()`-coerced, `Number.isFinite`-checked, `Math.trunc`'d and `Math.min`-clamped to 100 (`status/route.ts:41-42`) before reaching `rpc("fn_uniware_sync_runs", { p_limit: limit })`. **There is no P0 "service-role route taking user input" here.**
  - `lib/alerts/runDueAlerts.ts`, `lib/permit/client.ts`, `lib/postgrest/admin.ts`, `lib/supabase/userAdmin.ts`.
  - **`lib/storage/supabase.ts`** — the one that matters. Every storage operation runs as service-role, bypassing bucket policies, on the stated assumption that "a route handler already did its own `requirePageAccess`/role check before calling these" (`:14-16`). B-04 and B-06 are exactly the two routes where that assumption is false.

**Injection.** No raw SQL string interpolation exists anywhere in `web/app/api/`. Every DB touch goes through PostgREST's builder (`.eq/.in/.gte/.lte`, parameterised) or a named `rpc()` with a JSON argument object. Table and schema names are always string literals in source — never derived from user input. The one place user input reaches a query shape is `download-merged/route.ts:100` (`query.in("financial_year", fiscalYears)`), which is a parameterised value list, not interpolation. **No injection risk found.**

**Storage buckets.** Live check of `storage.buckets`:

```
erp-reports        | public=f | file_size_limit=NULL | allowed_mime_types=NULL
incentive-targets  | public=f | file_size_limit=NULL | allowed_mime_types=NULL
scheduled-exports  | public=f | file_size_limit=NULL | allowed_mime_types=NULL
```

All private — good. But all three have no server-side size or MIME ceiling, so the only limits are the ones in route code (which B-04 shows can be bypassed for `erp-reports`).

**Path traversal on the `[id]` download routes: not present.** `params.id` is only ever passed to `.eq("id", params.id)`; the storage path used for the fetch comes from the DB row (`upload.storage_path`), never from the URL. And on the write side `createUploadUrl`/`saveObjectFile` both normalise each path segment (`web/lib/storage/supabase.ts:31-34`, `:45-48`):

```ts
const safeRelative = relativePath.split("/").map((s) => s.replace(/[/\\]/g, "_")).join("/");
```

Combined with `register`'s `storagePath.startsWith(\`${reportType}/${user.id}/\`)` check (`register/route.ts:51`), the upload path space is properly bounded.

**Signed URL expiry.** `getDownloadUrl` uses `5 * 60` seconds (`lib/storage/supabase.ts:91`) — appropriately short. `createUploadUrl` uses Supabase's default upload-token lifetime (not specified in code); see UNVERIFIED.

---

## Integration reliability

| Integration | Timeout | Retry | Credential handling | Failure surfaced? |
|---|---|---|---|---|
| **Uniware SOAP** (`lib/uniware/client.ts:73`) | **None** (B-08) | **None** | Per-operation API key pairs from env — correct practice | Per-chunk/per-order try/catch → `errors[]` → persisted via `ops.fn_log_uniware_sync_run` and readable at `/api/cron/uniware-sync/status`. **Good** — except a platform timeout kills the process before the log write, leaving no row at all. |
| **Uniware REST** (`:325`, `:359`) | **None** | **None** | `UNIWARE_REST_USERNAME`/`PASSWORD` — **a personal portal login** (see Secrets) | Same pattern. **Notable: when REST creds are absent the entire returns phase is silently skipped and deliberately NOT recorded as an error** (`cron/uniware-sync/route.ts:228-233`). The reasoning is sound (a benign skip shouldn't flip `ok:false` forever) but the only signal is `summary.returnsSync.enabled` in a response body nobody reads on a scheduled run. In practice: a permanently-disabled phase that reports success. |
| **Sales-source Supabase** (`lib/salesSource/client.ts`) | Not set on the client (`createClient(url, key, {...})` at `:71`) | None | `signInWithPassword` with `SALES_USER_EMAIL`/`SALES_USER_PASSWORD` (`:92-96`) — **an end-user password, not a service identity** | Errors wrapped in `SalesSourceError` with `phase`, persisted into `raw_logic.sale_detail_sync_runs.errors`. **Best failure recording in the codebase** — the four recorded failures are legible enough to diagnose from the row alone. Undermined only by B-01 (nothing runs it) and by nothing reading that table. |
| **nodemailer / Gmail SMTP** (`lib/alerts/mailer.ts:26`) | **None** (B-13) | None | App-password, env-only, never logged | Errors bubble into the cron response `errors[]`; no persistence, no alerting-on-the-alerter. |
| **mssql / Logic ERP** (`app/(admin)/integrations/actions.ts:141-148`) | **`connectionTimeout: 8000`, `requestTimeout: 8000`** ✅ | None | Password AES-encrypted at rest via `core.fn_save_logic_erp_credentials` under `INTEGRATION_SECRET_KEY` (migration 0021); blank means "keep existing" (`:13-15`); **explicitly never logged** (`:112`); the test-connection path requires the password to be re-entered because the stored one can't be decrypted client-side (`:121`) | Returned to the admin UI directly. **The best-handled integration in the repo.** One caveat: `encrypt: true` with `trustServerCertificate: true` (`:147-148`) — session encrypted, but no CA validation, so MITM-able on the path to the ERP. Documented as deliberate. |
| **Permit.io** (`lib/permit/client.ts:16-24`) | None | `ignoreAlreadyInThatState` swallows 404/409 for idempotency (`:38-47`) — correctly scoped, rethrows everything else | `PERMIT_API_KEY`, **Development environment key** | **Runs in SHADOW MODE only** (`:5-8`) — it does not gate anything. Not a security dependency today. |
| **`minio` dependency** | n/a | n/a | n/a | Still in `web/package.json:26` but `lib/storage/minio.ts` is **retired** — `lib/storage/supabase.ts:5-6` documents the replacement, and no source file imports `minio`. Dead dependency; safe to drop. |

---

## VERIFIED CORRECT

- **Middleware exists and is correctly scoped.** `web/middleware.ts:26` matcher:
  `"/((?!_next/static|_next/image|favicon.ico|sh-test|api/cron|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"`.
  It runs on **every** `/api/*` route except `api/cron/*`. The cron exclusion is correct and well-documented (`:18-24`): Vercel Cron sends no Supabase cookie, so without the exclusion middleware would 307 every real cron invocation to `/login` before the route's own `CRON_SECRET` check ran. The excluded routes are precisely the ones that carry their own shared-secret auth. `/sh-test` is a dev proving ground with no production data path.
- **Middleware uses `getUser()`, not `getSession()`** (`lib/supabase/middleware.ts:33-38`) — verifies the JWT against Supabase instead of trusting the cookie. This is the correct choice and the comment explains why.
- **Middleware is not the only gate.** Every route independently re-checks `supabase.auth.getUser()`. No route relies on middleware alone.
- **All 5 cron routes check `CRON_SECRET`.** Confirmed line-by-line — no unauthenticated cron endpoint exists. (Subject to B-07's unset-variable caveat.)
- **`data-upload/register` correctly binds the storage path to the caller.** `register/route.ts:51`: `if (!storagePath.startsWith(\`${reportType}/${user.id}/\`))` → 400. This closes the "register a row pointing at someone else's object" hole, and the comment at `:46-50` shows it was a deliberate decision.
- **`data-upload/process/[id]/commit` never trusts client-supplied rows.** `commit/route.ts:30-34` and `:94` — it re-downloads and re-parses the workbook server-side on every call, then hands only server-parsed rows to a `SECURITY DEFINER` RPC that does its own role check. The client controls only `offset`/`batchSize`, both type- and range-checked (`:91-92`).
- **Commit is idempotent.** Writes go through `ops.fn_process_sale_upload` / `fn_upsert_synced_sale_rows`, upserting on the natural key `(branch_name, bill_date, bill_no, item_code, line_seq)` (migration 0024). Duplicate submission of the same batch is a no-op. Failure handling is correct too: the RPC's transaction rolls back including its own `status='processed'` update, so the route marks `failed` in a separate statement afterwards (`:74-80`, header `:36-40`).
- **`footfall/download` is the reference authorization implementation.** Session (`:34-38`) → role list (`:49-54`) → **and** an explicit `core.fn_user_store_ids()` membership check on the requested store (`:71-76`), returning a clean 403 rather than a silently empty file. Date params regex-validated (`:63-69`).
- **`replenishment/download` is the only route enforcing 0079 feature permissions server-side** (`:40-50`), ANDed with (not replacing) the role check. The comment at `:33-39` states the exact reasoning — hiding a link is view tailoring, not a gate. This is the pattern the other download routes should copy.
- **zod is genuinely used, not just a dependency.** Real schemas in `api/footfall` (`:7-17`), `api/targets/monthly` (`:20-30`), `api/targets/monthly/bulk-commit` (`:14-25`), `api/targets/remarks` (`:23-28`), plus four server-action files. All use `safeParse` and return a 400 on failure.
- **42501 is consistently mapped to a clean 403.** `footfall/route.ts:117-128`, `targets/monthly/route.ts:104-116`, `targets/remarks/route.ts:69-81`, `targets/monthly/bulk-commit/route.ts:63-75` — each converts a Postgres RLS denial into a user-facing message without leaking policy internals. Deliberate and consistent.
- **No stack traces or connection strings in any API response.** `err.stack` is returned by no route. `SUPABASE_DB_URL` is referenced by no route.
- **Non-disclosure on the `[id]` routes is intentional and correct.** A caller without the role gets an empty RLS-filtered select, which reads as 404 "not found" rather than 403 — so the endpoint doesn't confirm that a given id exists (`download/[id]:20-24`, `preview:24-27`).
- **`cron/uniware-sync/status` handles its one input properly** — coerce, finite-check, truncate, clamp to `MAX_LIMIT = 100` (`:41-42`). The model the other routes should follow.
- **`targets/monthly/audit-report` paginates correctly**, with a `line_id` keyset loop instead of a bare `.limit()`, and its header explains exactly why (`:20-24`) — it avoids the trap B-03 fell into, on the same class of query.
- **`uniware-sync` is scheduled and healthy.** `raw_uniware.sync_runs` shows `success=t` with zero errors for 23, 24, 25, 26 and 27 Aug (last run 2026-08-27 03:34 UTC, 42s). Contrary to the prior audit run's claim, this sync is not broken.
- **No secrets in git, and none reaching the client** — see the Secrets section for the exact commands and results.
- **No SQL injection surface** — no string-interpolated SQL anywhere in `web/app/api/`.
- **All three storage buckets are private** (`public = f`).
- **`admin_audit_log` is append-only** by grant, not by convention (`0079_permission_system.sql:112`, `:288`).
- **Permission-precedence logic is sound.** `lib/auth/access.ts:67-104` — deny-on-ancestor is checked *before* the exact-key override, so "a deny on a parent always beats an allow on a child" actually holds, and only DENY cascades (an allow on a page does not auto-grant its features). The comment at `:77-88` documents the real bug that ordering these the other way round caused.

---

## UNVERIFIED

1. **Is `CRON_SECRET` actually set in every Vercel environment?**
   B-07's severity hinges on this. Cannot be checked from the repo.
   *Check:* `vercel env ls` and confirm `CRON_SECRET` is present for Production, Preview **and** Development.

2. **Is Supabase's "Max Rows" setting still 1000 on this project?**
   B-03 relies on the repo's own live-confirmed note (2026-08-25) rather than a check I ran.
   *Check:* Supabase dashboard → Settings → API → Max Rows. Or empirically: `curl -H "apikey: $ANON" -H "Authorization: Bearer $USER_JWT" "$SUPABASE_URL/rest/v1/vw_sale_transactions_export?select=bill_no&limit=5000" | jq length` — if it returns exactly 1000, B-03 is confirmed.

3. **Does the Vercel project root point at `web/`?**
   `vercel.json` lives at `web/vercel.json`, not the repo root. If the project's Root Directory is the repo root, **none** of the three registered crons would be running either — which would make B-01 far worse. The `raw_uniware.sync_runs` evidence (clean daily runs at 03:34 UTC, matching the `0 3 * * *` entry) strongly implies the root **is** `web/` and the file is being read. Confirming closes the loop.
   *Check:* Vercel dashboard → Project → Settings → General → Root Directory; and Settings → Cron Jobs should list exactly three entries.

4. **`createUploadUrl` signed-upload-token lifetime.**
   `lib/storage/supabase.ts:36` calls `createSignedUploadUrl(safeRelative)` with no expiry argument, taking the Supabase default (believed 2 hours). Not confirmed against this project's version.
   *Check:* decode the `token` returned by `POST /api/data-upload/upload-url` and read its `exp` claim.

5. **Does the Vercel runtime actually reject a CRLF in a response header value?**
   Determines whether B-12 is inert or a real response-splitting vector.
   *Check:* as an `ho_admin`, `POST /api/data-upload/register` with `fileName: "a\r\nX-Injected: 1.xlsx"`, then `GET /api/data-upload/download/<id>` and inspect the raw response headers.

6. **Are Supabase auth cookies `SameSite=Lax` in this deployment?**
   Every mutating route (`api/footfall`, `api/targets/*`) is a cookie-authenticated POST with no CSRF token and no `Origin` check. `request.json()` parses the body regardless of `Content-Type`, so a cross-site `<form enctype="text/plain">` could post valid JSON. `SameSite=Lax` (the `@supabase/ssr` default) blocks this entirely — which is why it is not listed as a finding — but it is the *only* thing blocking it.
   *Check:* sign in and inspect the `sb-*-auth-token` cookie's `SameSite` attribute in DevTools. If it is `None`, this becomes a P1.

*(A seventh item — whether FY26-27 contains genuine RETURN bills at all — was resolved during the audit: 227 return lines totalling +279,199. B-02 is confirmed outright and quantified in its own section.)*

---

*End of report. No source file was modified during this audit; the only DB statements executed were `SELECT`s.*
