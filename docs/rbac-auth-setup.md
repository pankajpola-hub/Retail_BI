# RBAC & auth setup

Builds on `core.profiles`, `core.user_store_access`, `core.fn_user_role()`,
`core.fn_user_store_ids()` from [`supabase/migrations/0003_core_stores_rbac.sql`](../supabase/migrations/0003_core_stores_rbac.sql).
That migration is the actual security boundary — everything in this document
is either console configuration Postgres can't express, or app-side UX that
makes the RBAC model usable. **If the app-side checks below and the database
ever disagree, the database wins** — a bug that shows the wrong nav item is
a UX bug; a bug that lets a query through is a data breach. Treat every
in-app role check as a convenience redirect, never as the actual gate.

## 1. No public sign-up

EBO managers and regional managers don't self-register — Section 36/40 of the
brief assumes accounts are provisioned, not requested. In Supabase Auth:

**Authentication → Providers → Email** — leave enabled (it's what issues the
session), but the app itself never renders a sign-up form. The only entry
points that create a user are:

- `supabase.auth.admin.inviteUserByEmail()`, called from
  `app/(admin)/users/actions.ts` (the one admin.ts consumer for user
  provisioning — see the API layer plan, §6). This sends Supabase's built-in
  invite email with a magic link that lets the invitee set their own
  password on first login. The app never sees or sets a password on their
  behalf.
- Immediately after invite, the same server action inserts the matching
  `core.profiles` row (role) and `core.user_store_access` rows (store
  grants) using the service-role client — RLS on `core.profiles` has no
  `authenticated`-role INSERT policy at all, by design, so this step is
  necessarily service-role and necessarily gated by a `role === 'super_admin'`
  check in application code before that client is even constructed.

A user who authenticates but has no `core.profiles` row yet (invite sent,
provisioning step failed or is still pending) must be treated as
unauthorized, not defaulted to any role — see §4.

## 2. Session & password policy (Supabase console)

**Authentication → Settings:**

| Setting | Value | Why |
|---|---|---|
| Minimum password length | 12 | Store PCs are often shared/unlocked; a longer minimum is cheap insurance. |
| Email confirmations | Required | Closes the loop on the invite flow above. |
| Session timeout (JWT expiry) | 1 hour, with refresh token rotation on | Standard Supabase default; rotation means a stolen refresh token has a short window. |
| Refresh token reuse detection | On | Revokes the whole session chain if a used-up refresh token is replayed — catches token theft. |
| Rate limit: sign-in attempts | Keep platform default (30/hr/IP) or tighten if store PCs share a NAT IP and this starts false-positiving in practice | Brute-force protection; revisit if legitimate store staff get locked out. |

**MFA** (Authentication → Providers → enable TOTP): not required for
`ebo_manager` (adds friction to a screen the brief explicitly wants under 10
seconds to use), but **recommended for `ho_admin` and `super_admin`** — those
roles can see the whole network and provision other users. Enforce via an
app-side check at login: if `core.fn_user_role()` is `ho_admin` or
`super_admin` and the user has no MFA factor enrolled, redirect to an
enrollment screen before anything else renders. This is a UX nudge, not a
Postgres-level requirement — RLS doesn't know or care whether MFA happened,
so don't rely on this redirect as the actual boundary. If this needs to be a
hard requirement rather than a nudge, Supabase supports enforcing MFA via
Auth Hooks (a Postgres function invoked at token-issuance time) — worth
revisiting post-MVP if the nudge proves insufficient.

## 3. Role → route mapping

| Role | Route group | Landing page |
|---|---|---|
| `super_admin` | `(admin)`, plus full access to `(ho)` | `/admin` |
| `ho_admin` | `(ho)` | `/network` |
| `regional_manager` | `(ho)`, scoped by `core.user_store_access` | `/network` (filtered) |
| `ebo_manager` | `(ebo)` | `/my-store` |
| `marketing` | `(marketing)` | `/marketing/campaigns` |

`regional_manager` reuses the HO route group rather than getting its own —
the screens are identical, the only difference is which stores show up, and
that's already handled by `core.fn_user_store_ids()` at the data layer. Two
route groups for the same UI would just be two places to keep in sync.

## 4. Enforcement points (defense in depth, database is authoritative)

Three layers, each catching what the one before it might miss:

1. **`middleware.ts`** — is there a valid session at all? No session on a
   protected path → redirect to `/login`. This is the cheapest check and
   runs on every request; it knows nothing about roles.
2. **Route group `layout.tsx`** — given a valid session, does
   `core.profiles.role` (fetched once per request, server-side) belong in
   this route group? Wrong role → redirect to their actual landing page
   from §3. This is what makes an `ebo_manager` who guesses `/network` in
   the URL bar bounce to `/my-store` instead of seeing a broken page — but
   note this is a redirect for UX coherence, not the reason they can't see
   other stores' data. That reason is RLS, layer 3.
3. **RLS + `core.fn_user_store_ids()`** — the actual authorization boundary,
   already built in the migrations. Even if layers 1 and 2 had a bug and let
   the wrong role render the HO dashboard, every query on that page still
   comes back filtered to whatever `fn_user_store_ids()` returns for that
   session. This is the layer that must never be bypassed, and it's also the
   only layer that's already fully implemented in SQL.

Practical implication for testing: **testing layers 1–2 (redirects) is a
frontend concern; testing layer 3 (can an `ebo_manager` actually read another
store's row via a crafted request) is a database concern**, and should be
tested by calling PostgREST directly with that user's JWT, not by clicking
around the app — clicking around only proves the redirect works, not that
the query would have been blocked if the redirect hadn't fired.

## 5. Local dev / testing seed

`supabase/seed.sql` (not yet created — add when local dev starts) should
provision one user per role against the local Supabase instance:

```
ho.admin@ebo.test        → ho_admin
regional.west@ebo.test   → regional_manager, granted BO-001 + BO-003
manager.undri@ebo.test   → ebo_manager, granted BO-001 only
manager.sinhgad@ebo.test → ebo_manager, granted BO-003 only
marketing@ebo.test       → marketing
```

With `regional.west` and both `ebo_manager`s covering overlapping stores,
the seed itself becomes a regression test: `manager.undri` querying
`sales.vw_ebo_sales_daily` should get BO-001 rows only, never BO-003 — if a
future migration change accidentally widens that, it's visible immediately
in local dev rather than surfacing as a production data leak.

## 6. What's explicitly deferred

- **Audit logging** (Section 37 of the brief) — no `core.audit_log` table
  exists yet. The RBAC-sensitive surfaces that most need it are
  `core.user_store_access` changes (who granted whom access to what store)
  and `ops.action_items` status transitions. Worth its own migration once
  the schema is running in a real environment rather than speculatively
  built now against no observed access patterns.
- **Auth Hooks for hard MFA enforcement** — noted in §2 as a fallback if the
  redirect-based nudge for `ho_admin`/`super_admin` proves insufficient.
- **Phone/OTP login** — email+invite is the MVP path; if store managers turn
  out to prefer phone-based login in practice, Supabase supports it as an
  additional provider without changing the RBAC model underneath.
