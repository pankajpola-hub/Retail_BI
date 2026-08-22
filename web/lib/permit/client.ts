import "server-only";
import { Permit } from "permitio";

/**
 * Permit.io client — page-access authorization running in SHADOW MODE
 * alongside the existing Postgres/lib/auth/roles.ts checks, not replacing
 * them yet. See requirePageAccess() in lib/auth/roles.ts for where this is
 * called and why it doesn't gate access on its own yet.
 *
 * Single instance per server process, same pattern as
 * lib/supabase/admin.ts's createAdminClient() — cheap to construct, but no
 * reason to build a new one per call.
 */
let cached: Permit | null = null;

export function getPermit(): Permit {
  if (!cached) {
    cached = new Permit({
      token: process.env.PERMIT_API_KEY!,
      pdp: "https://cloudpdp.api.permit.io",
    });
  }
  return cached;
}

// Every user lives in this one tenant — this app has no multi-tenant concept
// of its own (all EBO stores are one organization), so "default" (which
// Permit.io creates for every new environment) is the only tenant this
// project will ever need.
export const PERMIT_TENANT = "default";

const OVERRIDE_ROLE_PREFIX = "override-";

// Swallows exactly the outcomes that mean "already in the state we wanted"
// (409 already-exists/already-assigned, 404 not-found/not-assigned) so
// syncPermitUserAccess stays idempotent and safe to re-run — anything else
// (auth failure, network error, a real validation error) still throws.
async function ignoreAlreadyInThatState(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const status = (err as { response?: { status?: number }; status?: number })?.response?.status ?? (err as { status?: number })?.status;
    const message = String((err as { message?: unknown })?.message ?? err);
    if (status === 404 || status === 409 || /already exists|not found|not assigned/i.test(message)) return;
    throw err;
  }
}

/**
 * Mirrors a user's EFFECTIVE page access into Permit.io — the same "role
 * default, narrowed or widened by core.user_page_overrides" answer
 * lib/auth/roles.ts's requirePageAccess() computes from Postgres.
 *
 * `effectivePages === null` means "no overrides for this user" — the common
 * case, handled with a plain role assignment (assignRole/unassignRole are
 * both idempotent here via ignoreAlreadyInThatState).
 *
 * `effectivePages` as an array means this user has at least one override
 * row. Permit.io's role permissions are ADDITIVE (union across every role a
 * user holds) — there is no "deny" primitive, so an override that NARROWS
 * access (e.g. revoking a page a role would normally grant) can't be
 * expressed by layering an extra role on top of the base one; the base role
 * assignment has to come OFF entirely. Instead we synthesize one role per
 * such user (key `override-<userId>`) whose permission set IS their exact
 * effective page list, and that role becomes their ONLY assignment. This is
 * the standard way to express a per-user RBAC exception without reaching for
 * ABAC condition sets — correct for both widening and narrowing, at the cost
 * of one extra role per user who actually has an override (expected to stay
 * rare — page overrides are called an "infrequent admin action" in
 * users/actions.ts today).
 */
export async function syncPermitUserAccess(
  userId: string,
  fullName: string,
  role: string,
  effectivePages: string[] | null
): Promise<void> {
  const permit = getPermit();
  await permit.api.users.sync({ key: userId, first_name: fullName });

  const overrideRoleKey = `${OVERRIDE_ROLE_PREFIX}${userId}`;

  if (effectivePages === null) {
    await ignoreAlreadyInThatState(() =>
      permit.api.users.unassignRole({ user: userId, role: overrideRoleKey, tenant: PERMIT_TENANT })
    );
    await ignoreAlreadyInThatState(() => permit.api.users.assignRole({ user: userId, role, tenant: PERMIT_TENANT }));
    return;
  }

  const permissions = effectivePages.map((p) => `${p}:view`);
  try {
    await permit.api.roles.create({ key: overrideRoleKey, name: `Override — ${fullName}`, permissions });
  } catch (err) {
    const status = (err as { response?: { status?: number }; status?: number })?.response?.status ?? (err as { status?: number })?.status;
    const message = String((err as { message?: unknown })?.message ?? err);
    if (status === 409 || /already exists/i.test(message)) {
      await permit.api.roles.update(overrideRoleKey, { permissions });
    } else {
      throw err;
    }
  }

  await ignoreAlreadyInThatState(() => permit.api.users.unassignRole({ user: userId, role, tenant: PERMIT_TENANT }));
  await ignoreAlreadyInThatState(() =>
    permit.api.users.assignRole({ user: userId, role: overrideRoleKey, tenant: PERMIT_TENANT })
  );
}
