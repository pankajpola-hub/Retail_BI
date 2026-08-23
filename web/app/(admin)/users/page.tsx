import { createClient } from "@/lib/data/client";
import { createAdminClient as createSupabaseAdmin } from "@/lib/supabase/admin";
import { requirePageAccess } from "@/lib/auth/roles";
import { resolveAccess } from "@/lib/auth/access";
import type { AppRole, UserStatus, ActionClass } from "@/lib/auth/permissions";
import type { BusinessUnit } from "@/lib/auth/roles";
import { InviteUserForm } from "./invite-user-form";
import { UsersAdmin, type UserRow, type FeatureKeyRow, type AuditRow } from "./UsersAdmin";
import { getDict } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

type Profile = {
  user_id: string;
  full_name: string;
  role: AppRole;
  status: UserStatus;
  last_active_at: string | null;
};
type Store = { store_id: string; store_name: string };
type Grant = { user_id: string; store_id: string };
type BusinessUnitGrant = { user_id: string; business_unit: BusinessUnit };
type OverrideRow = { user_id: string; permission_key: string; allowed: boolean };
type RolePermissionRow = { role: AppRole; permission_key: string };

/**
 * 2026-08-23 rebuild (migration 0079). The previous version was a flat <ul>
 * with five inline-expanding buttons crammed into each row, and it was
 * missing things an admin panel genuinely needs: no way to change a role, no
 * way to disable a departing user, no audit trail, and a page-rights control
 * that covered only 7 of the 11 gated pages because the client component had
 * re-declared its own PageKey union by hand and drifted.
 *
 * Now: the same faceted-table system the rest of the app uses
 * (components/ui/FacetFilterBar.tsx), with per-user detail in a dialog —
 * permissions, scope, and that user's own audit history.
 */
export default async function UsersPage() {
  // requirePageAccess (0035, now backed by core.role_permissions per 0079)
  // layers a per-user override on top of the role default — (admin)/layout.tsx's
  // gate is coarse (it also hosts /integrations, a different page_key), so the
  // "users" page_key check has to happen here instead.
  const me = await requirePageAccess("users");

  const supabase = await createClient();
  const t = await getDict();

  // 0079 — capability gates WITHIN this page. Everyone here is already a
  // super_admin (that's the page's own role default), so these exist to make a
  // narrower admin possible: someone who can review users and the audit trail
  // without being able to reset passwords or rewrite permissions. Granted to
  // super_admin by default, so nothing changes until an admin revokes one.
  //
  // The server actions re-check super_admin independently — these gates hide
  // controls, they don't replace requireSuperAdminCaller().
  const access = await resolveAccess();
  const canInvite = access?.can("users.invite.admin") ?? true;
  const canEditRole = access?.can("users.role.admin") ?? true;
  const canEditStatus = access?.can("users.status.admin") ?? true;
  const canResetPassword = access?.can("users.password.admin") ?? true;
  const canEditPermissions = access?.can("users.permissions.admin") ?? true;
  const canViewAudit = access?.can("users.audit.view") ?? true;

  const [
    { data: profiles },
    { data: stores },
    { data: grants },
    { data: businessUnitGrants },
    { data: overrides },
    { data: featureKeys },
    { data: rolePermissions },
    { data: audit },
  ] = await Promise.all([
    supabase
      .schema("core")
      .from<Profile>("profiles")
      .select("user_id, full_name, role, status, last_active_at")
      .order("full_name"),
    supabase.schema("core").from<Store>("stores").select("store_id, store_name").order("store_id"),
    supabase.schema("core").from<Grant>("user_store_access").select("user_id, store_id"),
    supabase.schema("core").from<BusinessUnitGrant>("user_business_units").select("user_id, business_unit"),
    supabase
      .schema("core")
      .from<OverrideRow>("user_permission_overrides")
      .select("user_id, permission_key, allowed"),
    // enforced = true ONLY. A key may exist in the registry before its
    // server-side gate is wired; showing a toggle that does nothing would be
    // a lie an admin would reasonably trust. See 0079's comment on `enforced`.
    supabase
      .schema("core")
      .from<FeatureKeyRow>("feature_keys")
      .select("key, page_key, label, action_class, is_page, sort_order")
      .eq("enforced", true)
      .order("sort_order"),
    supabase.schema("core").from<RolePermissionRow>("role_permissions").select("role, permission_key"),
    supabase
      .schema("core")
      .from<AuditRow>("admin_audit_log")
      .select("id, actor_name, action, target_user_id, target_user_name, detail, created_at")
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  // Emails live in auth.users, not core.profiles, so they need the service-role
  // client. Safe here: this page is super_admin-gated above, and only the
  // address is read.
  const emailById = new Map<string, string>();
  try {
    const admin = createSupabaseAdmin();
    const { data: authUsers } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    for (const u of authUsers?.users ?? []) if (u.email) emailById.set(u.id, u.email);
  } catch {
    // Non-fatal: the table renders without emails rather than failing outright.
  }

  // BO-004 (Phoenix Palassio, Lucknow) is discontinued — kept visible only on
  // /network for historical reference; not offered as a store to grant.
  const activeStores = (stores ?? []).filter((s) => s.store_id !== "BO-004");
  const storeNames = new Map(activeStores.map((s) => [s.store_id, s.store_name]));

  const storesByUser = new Map<string, string[]>();
  for (const g of grants ?? []) {
    storesByUser.set(g.user_id, [...(storesByUser.get(g.user_id) ?? []), g.store_id]);
  }

  const businessUnitsByUser = new Map<string, BusinessUnit[]>();
  for (const g of businessUnitGrants ?? []) {
    businessUnitsByUser.set(g.user_id, [...(businessUnitsByUser.get(g.user_id) ?? []), g.business_unit]);
  }

  const overridesByUser: Record<string, Record<string, boolean>> = {};
  for (const o of overrides ?? []) {
    (overridesByUser[o.user_id] ??= {})[o.permission_key] = o.allowed;
  }

  const rolePermissionMap: Record<string, string[]> = {};
  for (const rp of rolePermissions ?? []) {
    (rolePermissionMap[rp.role] ??= []).push(rp.permission_key);
  }

  const rows: UserRow[] = (profiles ?? []).map((p) => {
    const userStores = storesByUser.get(p.user_id) ?? [];
    return {
      userId: p.user_id,
      fullName: p.full_name,
      email: emailById.get(p.user_id) ?? "",
      role: p.role,
      status: p.status ?? "active",
      lastActiveAt: p.last_active_at,
      storeIds: userStores,
      storeLabel:
        p.role === "super_admin" || p.role === "ho_admin"
          ? "All stores"
          : userStores.length === 0
          ? "—"
          : userStores.map((id) => storeNames.get(id) ?? id).join(", "),
      businessUnits: businessUnitsByUser.get(p.user_id) ?? [],
      overrideCount: Object.keys(overridesByUser[p.user_id] ?? {}).length,
    };
  });

  return (
    <main className="py-6">
      <h1 className="font-serif text-2xl">{t.usersTitle}</h1>
      <p className="mt-1 text-[12.5px] text-ink-3">{t.usersSubtitle}</p>

      {canInvite && (
        <>
          <h2 className="mt-6 text-[11px] font-semibold uppercase tracking-wide text-ink-3">{t.addUserTitle}</h2>
          <div className="mt-2">
            <InviteUserForm stores={activeStores} />
          </div>
        </>
      )}

      <UsersAdmin
        rows={rows}
        currentUserId={me.id}
        stores={activeStores}
        featureKeys={(featureKeys ?? []) as FeatureKeyRow[]}
        rolePermissions={rolePermissionMap}
        overridesByUser={overridesByUser}
        audit={canViewAudit ? ((audit ?? []) as AuditRow[]) : []}
        canEditRole={canEditRole}
        canEditStatus={canEditStatus}
        canEditPermissions={canEditPermissions}
        canResetPassword={canResetPassword}
        canViewAudit={canViewAudit}
      />
    </main>
  );
}

export type { ActionClass };
