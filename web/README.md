# Nexus Revenue — web app

Next.js 14 (App Router) + TypeScript + Tailwind, over the Supabase schema in
[`../supabase`](../supabase/README.md). No component kit, no chart library —
the mockup's design language is hand-rolled CSS/SVG on purpose (see the
`artifact-design` review from the mock stage), so the scaffold follows suit
rather than importing a pre-styled system that would fight it.

Read these two before touching auth or data fetching — this scaffold is a
direct implementation of both:

- [`../docs/rbac-auth-setup.md`](../docs/rbac-auth-setup.md) — the three
  enforcement layers, why the database is always the real one.
- [`../docs/api-layer-plan.md`](../docs/api-layer-plan.md) — why there's
  barely a custom API, and which few things justify a Route Handler.

## Getting running

```bash
npm install
cp .env.example .env.local   # fill in your Supabase project's values
npm run supabase:types       # requires migrations applied + supabase login
npm run dev
```

Requires the migrations in `../supabase/migrations` already applied
(`supabase db push`) and `core, sales, ops, marketing` added under
**Project Settings → API → Exposed schemas** in the Supabase console — see
`docs/api-layer-plan.md` §1. Nothing here will return data without that step.

## What's actually wired vs. what's a placeholder

Wired end-to-end, as a reference for the pattern:

- **Auth**: `/login` → `lib/auth/roles.ts` → role-gated route group layouts.
- **Footfall entry**: `(ebo)/footfall` Client Component → `POST /api/footfall`
  → `ops.ebo_footfall_daily` upsert, with the trigger's validation error
  translated into user-facing copy.
- **User provisioning**: `(admin)/users/actions.ts` → the one
  `lib/supabase/admin.ts` consumer for this purpose, double-checking the
  caller is `super_admin` independent of the layout gate.

Placeholder — real query, minimal UI, mock screen number noted in each file's
comment for what the finished screen should look like:

- `(ho)/network` (screen 01), `(ebo)/my-store` (screen 04),
  `(marketing)/campaigns` (screen 07), `(admin)/users` (Section 36).

Not started: store diagnosis (02), action queue (03), CSV import wizard (06),
what-if simulator (08) — each has its data source already identified in
`docs/api-layer-plan.md`'s screen → source table.

## Directory map

```
app/
  login/                    unauthenticated
  (ho)/                     ho_admin, regional_manager, super_admin
  (ebo)/                    ebo_manager
  (marketing)/              marketing, ho_admin, super_admin
  (admin)/                  super_admin only
  api/                      Route Handlers — see api-layer-plan.md §4 for
                             why each one exists
lib/
  supabase/{server,client,admin,middleware}.ts   — the three trust levels
  auth/roles.ts             requireRole(), ROLE_HOME
  types/database.ts         generated, do not hand-edit
components/ui/               shared primitives ported from the mock's CSS
```
