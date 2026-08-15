# API layer plan — Vercel app over the Supabase schema

Scope: how the Next.js app on Vercel talks to the schema in [`supabase/`](../supabase/README.md).
The central decision is **there is barely a custom API layer** — RLS on the
Postgres side already does the authorization work per screen/role from the
mock, so most reads go straight from Server Components to Supabase views via
PostgREST. Route Handlers exist only where something genuinely needs
server-side logic beyond "run this query as this user": file parsing, batch
writes, or actions that must never be reachable from the browser at all.

## 1. One prerequisite Supabase project setting

By default PostgREST (what `supabase-js` talks to) only exposes the `public`
schema. Every view built in the migrations lives in `core`, `sales`, `ops`,
`marketing` — none of them are reachable until this is set:

**Project Settings → API → Exposed schemas** → add `core, sales, ops, marketing`.

Without this step every query in this document 404s. It's the one manual
console step nothing in `supabase/` automates.

## 2. Three Supabase clients, three trust levels

```
lib/supabase/
  server.ts   — @supabase/ssr createServerClient(), anon key, reads the
                user's session from cookies. Used in Server Components and
                Route Handlers. RLS is enforced as that user — this is the
                default and should be reached for by default.
  client.ts   — @supabase/ssr createBrowserClient(), anon key. Used only in
                Client Components that need live interaction (the footfall
                numeric keypad, the what-if simulator sliders). RLS still
                enforced as that user.
  admin.ts    — createClient() with SUPABASE_SERVICE_ROLE_KEY. Bypasses RLS
                entirely. Imported by exactly the files listed in §6, nowhere
                else. Never imported by any file under app/**/page.tsx or any
                Client Component — grep for "admin.ts" in review before merge.
```

`SUPABASE_SERVICE_ROLE_KEY` is a server-only env var (no `NEXT_PUBLIC_`
prefix). The three-file split makes "did this leak service-role access to
the browser" a one-directory code review question instead of an audit of
every fetch call.

## 3. Reads: Server Components query views directly, no Route Handler

Every screen in the mock maps to a view or RPC function that already filters
by `core.fn_user_store_ids()`. A Server Component does not need a `/api/*`
hop to get RLS-correct, role-scoped data — it queries Supabase directly:

```ts
// app/(ho)/network/page.tsx
const supabase = createServerClient();
const { data: daily } = await supabase.schema('sales').from('vw_ebo_sales_daily')
  .select('*').gte('bill_date', weekStart).order('bill_date');
```

An `ebo_manager`'s session hitting this exact same query gets back only their
own store's rows — the view's `WHERE store_id = ANY(core.fn_user_store_ids())`
already did the filtering. **The app never adds its own `WHERE store_id =`
clause for authorization** — that would be redundant with RLS at best and a
second place to get it wrong at worst. App-level `WHERE` clauses are for
narrowing within an already-authorized set (a date range, a single store the
user picked from their own list), never for restricting to what they're
*allowed* to see.

Screen → data source map:

| Screen | Primary source |
|---|---|
| 01 HO executive | `sales.vw_ebo_sales_daily`, `sales.vw_ebo_sales_weekly`, `sales.vw_ebo_scheme_daily`, `ops.vw_action_queue_summary` |
| 02 Store diagnosis | `sales.vw_ebo_sales_weekly`, `rpc('fn_diagnose_store')`, `rpc('fn_compute_store_health')` |
| 03 Action queue | `ops.action_items` (select), joined client-side to `core.stores` |
| 04 EBO my store | `ops.vw_ebo_conversion_daily`, `sales.vw_ebo_sales_weekly`, `rpc('fn_diagnose_store')` |
| 05 Footfall entry | `sales.vw_ebo_sales_daily` (today's bill count, for the "conversion after save" line), then a direct insert |
| 06 CSV import | Route Handler — see §4 |
| 07 Campaign results | `marketing.vw_campaign_metrics`, `marketing.vw_campaign_failure_reasons`, `marketing.vw_campaign_store_impact` |
| 08 What-if simulator | `sales.vw_ebo_sales_weekly` for the baseline; the lever math itself runs client-side (it's arithmetic on numbers already fetched, not a new query per slider drag) |

RPC calls (`fn_diagnose_store`, `fn_compute_store_health`) go through
`supabase.rpc('fn_diagnose_store', { p_store_id, p_week_start })` — same
server client, same session, `security invoker`/`security definer` on the
Postgres side already worked out in the migrations.

## 4. Route Handlers — only where server-side logic is unavoidable

Everything in this section exists because RLS alone can't do the job, not
because it's "an API endpoint" in the generic sense.

### `POST /api/footfall`
Thin wrapper, mostly for the mobile-first save flow to get a clean JSON error
back (RLS/trigger rejections raise Postgres errors that need translating into
the "Footfall can't be less than today's bills" copy from the mock). Direct
`.insert()`/`.upsert()` against `ops.ebo_footfall_daily` from the server
client — the `ops.fn_validate_footfall` trigger and RLS policies are the real
enforcement; this handler exists for error-message quality, not security.

### `POST /api/marketing/import/validate` → `preview` → `commit`
The three-to-five step wizard in the mock, as three Route Handlers:

- **validate** — accepts the uploaded CSV (multipart, size-capped, `.csv`
  MIME-checked), parses server-side (never trust a client-reported row
  count), runs the structural checks from the mock (blank rows, duplicate
  phones, contradictory status flags, numeric field sanity) and returns a
  validation report. **Does not write to the database yet.**
- **preview** — takes the validated parse plus the user's column mapping and
  the required manual fields (campaign name, date, stores — the three things
  the DelightChat export can't supply), returns the first 10–20 mapped rows
  for on-screen confirmation. Still no write.
- **commit** — the only step that writes. Creates the `marketing.campaigns` /
  `campaign_stores` rows, then upserts `campaign_recipients` using the
  `ON CONFLICT (campaign_id, recipient_phone)` pattern from the schema
  README, and writes one `campaign_import_batches` row per attempt regardless
  of outcome (audit trail survives even a failed or duplicate commit).

All three run under the *user's* session via the server client — RLS on
`marketing.*` already restricts inserts to `marketing`/`ho_admin`/
`super_admin` roles, so this needs no service-role escalation. The reason
it's a Route Handler at all is CSV parsing and multi-row batching, which
don't belong in a Server Component render path.

### `POST /api/actions/:id/resolve`
Closing an `ops.action_items` row. Small but deliberately not a bare
`.update()` from the client: the handler requires `result_metric`,
`result_before`, `result_after` to be present *or* an explicit
`acknowledge_unmeasured: true` flag before allowing status → `completed`.
This is where the mock's "closed, unmeasured is itself a KPI" rule gets
enforced procedurally rather than trusted to UI discipline alone.

## 5. Client Components: interactive, not authoritative

The what-if simulator (screen 08) and the footfall numeric keypad (screen 05)
are Client Components for responsiveness, but neither trusts the client for
anything that matters:

- The simulator's lever math (footfall/conversion/ATV/UPT → projected sales)
  runs in the browser purely for instant slider feedback. It is never
  persisted from the client — if "save this scenario" becomes a feature, that
  write goes through a Route Handler that recomputes server-side before
  storing, so a tampered client payload can't write a fabricated projection.
- The footfall keypad calls `/api/footfall`, not a direct `.insert()` from
  the browser client — even though RLS would technically allow it, routing
  through the handler keeps the "translate Postgres errors into UI copy"
  logic in one place instead of duplicated in every Client Component that
  writes footfall (currently one, but the action-resolve flow will want the
  same pattern).

## 6. The only files allowed to import `lib/supabase/admin.ts`

Kept to an explicit, reviewable list rather than an implicit "wherever
someone reached for it":

- `app/(admin)/users/actions.ts` — provisioning `core.profiles` +
  `core.user_store_access` rows. RLS on `core.profiles` has no
  `authenticated`-role INSERT policy at all (see `0003_core_stores_rbac.sql`)
  by design, so user provisioning is necessarily a service-role operation —
  gated in this file by an explicit `role === 'super_admin'` check before
  the client is even constructed, not left to RLS to catch.
- `app/(admin)/health-config/actions.ts` — editing
  `ops.health_score_factors` weights. RLS already restricts this to
  `ho_admin`/`super_admin`, so admin.ts isn't strictly required here; it's
  used anyway so weight changes are logged through a single audited path
  rather than mixed with the RLS-only mutation pattern used everywhere else.

Nothing else. If a future PR needs a third file here, that's a design
decision worth a second look, not a quick import.

## 7. Caching

Store- and role-scoped data is not safely cacheable across users by default,
so the default posture is **no cache**:

- Pages reading `sales.*`/`ops.*`/`marketing.*` are `export const dynamic =
  'force-dynamic'` — correctness over speed for numbers a store manager is
  about to act on.
- `core.retail_calendar` and `core.stores` are the exception: not
  user-scoped, change rarely. Fetched with Next.js `fetch`-level caching
  (`revalidate: 3600`) or loaded once into a shared client-side context at
  app shell mount.
- After a mutation (`POST /api/footfall`, action resolve, campaign commit),
  call `revalidatePath()` on the specific page(s) that just went stale rather
  than reaching for a broader cache-bust — the HO action queue and the
  single EBO's own dashboard are the only two views a footfall save should
  invalidate, for example.

## 8. Error contract

Route Handlers return a consistent shape so the frontend has one error-handling
path:

```ts
// success
{ ok: true, data: T }
// failure
{ ok: false, error: { code: string, message: string, details?: unknown } }
```

Postgres/PostgREST errors get translated at the handler boundary, not passed
through raw: RLS denials (`42501`, or PostgREST's `PGRST301`) become a 403
with a role-appropriate message ("Your account doesn't have access to
BO-014"), the footfall trigger's `raise exception` becomes a 400 with the
exact validation copy from the mock ("Footfall can't be lower than today's 2
bills"), unique-violation on `campaign_recipients` becomes a no-op success
(that's the intended upsert path, not an error the user should see).

## 9. What's explicitly out of scope for the MVP API layer

- **No GraphQL / no hand-rolled REST resource layer.** PostgREST via
  supabase-js already gives filtering, pagination, and joins on the views;
  adding a second API abstraction on top would just be indirection.
- **No Realtime subscriptions yet.** The HO action queue and store diagnosis
  would benefit from live updates eventually (Phase 2+), but the MVP ships
  with request-time freshness (`force-dynamic` + `revalidatePath`), which is
  enough for daily-cadence retail data and avoids taking on Realtime's
  connection-management surface before the core loop is proven.
- **No background job runner in this app.** Nightly rollups, if ever needed
  beyond what the views compute on read, are a Supabase cron/Edge Function
  concern, not something Vercel serverless functions should be doing on a
  schedule.
