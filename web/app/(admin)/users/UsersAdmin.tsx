"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useProgressTransition } from "@/components/ui/useProgressTransition";
import {
  FacetFilterBar,
  applyFacetFilter,
  buildGroupedRows,
  emptyFilterState,
  type FacetDef,
  type AdvField,
  type FacetFilterState,
} from "@/components/ui/FacetFilterBar";
import {
  APP_ROLES,
  ROLE_LABELS,
  type ActionClass,
  type AppRole,
  type UserStatus,
} from "@/lib/auth/permissions";
import { updateUserRole, setUserStatus } from "./actions";
import { UserDetailDialog } from "./UserDetailDialog";

const PAGE_KEY = "admin_users";

export type UserRow = {
  userId: string;
  fullName: string;
  email: string;
  role: AppRole;
  status: UserStatus;
  lastActiveAt: string | null;
  storeIds: string[];
  storeLabel: string;
  businessUnits: string[];
  overrideCount: number;
};

export type FeatureKeyRow = {
  key: string;
  page_key: string;
  label: string;
  action_class: ActionClass;
  is_page: boolean;
  sort_order: number;
};

export type AuditRow = {
  id: number;
  actor_name: string;
  action: string;
  target_user_id: string | null;
  target_user_name: string | null;
  detail: Record<string, unknown>;
  created_at: string;
};

/**
 * The Users admin table (migration 0079). Uses the same faceted-filter engine
 * as Movement and Network (components/ui/FacetFilterBar.tsx) so this page
 * behaves like the rest of the app rather than being the one screen with its
 * own bespoke filtering.
 *
 * Role and status are edited INLINE in the row — they're single-value choices
 * with real consequences, and burying them a dialog deep made the two most
 * common admin actions the two slowest. Everything with more surface area
 * (per-key permissions, store/unit scope, that user's history) lives in the
 * detail dialog.
 */
export function UsersAdmin({
  rows,
  currentUserId,
  stores,
  featureKeys,
  rolePermissions,
  overridesByUser,
  audit,
  canEditRole,
  canEditStatus,
  canEditPermissions,
  canResetPassword,
  canViewAudit,
}: {
  rows: UserRow[];
  currentUserId: string;
  stores: { store_id: string; store_name: string }[];
  featureKeys: FeatureKeyRow[];
  rolePermissions: Record<string, string[]>;
  overridesByUser: Record<string, Record<string, boolean>>;
  audit: AuditRow[];
  canEditRole: boolean;
  canEditStatus: boolean;
  canEditPermissions: boolean;
  canResetPassword: boolean;
  canViewAudit: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<FacetFilterState>(emptyFilterState);
  const [openUserId, setOpenUserId] = useState<string | null>(null);
  const [pending, startTransition] = useProgressTransition();
  const [error, setError] = useState<string | null>(null);

  const facets = useMemo<FacetDef<UserRow>[]>(
    () => [
      { key: "role", label: "Role", get: (r) => ROLE_LABELS[r.role] },
      { key: "status", label: "Status", get: (r) => (r.status === "active" ? "Active" : "Disabled") },
      // A user can hold several business units, so this facet matches on the
      // joined label — the engine's get() is single-valued by design.
      { key: "businessUnit", label: "Business unit", get: (r) => r.businessUnits.join(" + ") || "none" },
    ],
    []
  );

  const advFields = useMemo<AdvField<UserRow>[]>(
    () => [
      { key: "fullName", label: "Name", get: (r) => r.fullName },
      { key: "email", label: "Email", get: (r) => r.email },
      { key: "storeLabel", label: "Store access", get: (r) => r.storeLabel },
      { key: "overrideCount", label: "Custom permissions", get: (r) => r.overrideCount, numeric: true },
    ],
    []
  );

  const groupByOptions = useMemo(
    () => [
      { key: "role", label: "Role" },
      { key: "status", label: "Status" },
    ],
    []
  );
  const groupKeyGetters = useMemo<Record<string, (row: UserRow) => string>>(
    () => ({
      role: (r) => ROLE_LABELS[r.role],
      status: (r) => (r.status === "active" ? "Active" : "Disabled"),
    }),
    []
  );

  const filtered = useMemo(
    () => applyFacetFilter(rows, facets, advFields, state),
    [rows, facets, advFields, state]
  );
  const gridRows = useMemo(
    () => buildGroupedRows(filtered, state.groupBy, groupKeyGetters),
    [filtered, state.groupBy, groupKeyGetters]
  );

  const openUser = rows.find((r) => r.userId === openUserId) ?? null;

  function run(fn: () => Promise<void>) {
    setError(null);
    startTransition(async () => {
      try {
        await fn();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Update failed.");
      }
    });
  }

  return (
    <>
      <h2 className="mt-8 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Existing users</h2>

      <div className="mt-2">
        <FacetFilterBar
          pageKey={PAGE_KEY}
          rows={rows}
          facets={facets}
          advFields={advFields}
          groupByOptions={groupByOptions}
          state={state}
          onChange={setState}
        />
      </div>

      <div className="mb-2 text-[12px] text-ink-3">
        {filtered.length === rows.length ? `${filtered.length} users` : `${filtered.length} of ${rows.length} users`}
      </div>

      {error && (
        <p className="mb-2 border-l-2 border-crit bg-crit-soft px-3 py-2 text-[12.5px] text-crit">{error}</p>
      )}

      <div className="overflow-x-auto rounded-md border border-line-soft bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line-soft bg-surface-2 text-left text-[10px] uppercase tracking-wide text-ink-2">
              <th className="px-3 py-2">User</th>
              <th className="px-3 py-2">Role</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Business unit</th>
              <th className="px-3 py-2">Store access</th>
              <th className="px-3 py-2">Permissions</th>
              <th className="px-3 py-2 text-right">Manage</th>
            </tr>
          </thead>
          <tbody>
            {gridRows.map((row) =>
              "__groupHeader" in row ? (
                <tr key={row.id} className="border-b border-line-soft bg-surface-2">
                  <td
                    colSpan={7}
                    className="px-3 py-1.5 text-[12px] font-semibold text-ink-2"
                    style={{ paddingLeft: 12 + row.level * 16 }}
                  >
                    {row.label} <span className="font-mono font-normal text-ink-3">({row.count})</span>
                  </td>
                </tr>
              ) : (
                <tr
                  key={row.userId}
                  className={`border-b border-line-soft last:border-0 hover:bg-surface-2 ${
                    row.status === "disabled" ? "opacity-60" : ""
                  }`}
                >
                  <td className="px-3 py-2">
                    <div className="font-medium">{row.fullName}</div>
                    {row.email && <div className="text-[11.5px] text-ink-3">{row.email}</div>}
                  </td>

                  <td className="px-3 py-2">
                    <select
                      value={row.role}
                      disabled={pending || row.userId === currentUserId || !canEditRole}
                      title={
                        row.userId === currentUserId
                          ? "You can't change your own role — ask another super admin."
                          : !canEditRole
                          ? "You don't have permission to change roles."
                          : undefined
                      }
                      onChange={(e) => run(() => updateUserRole(row.userId, e.target.value as AppRole))}
                      className="min-h-[30px] rounded-md border border-line bg-surface px-1.5 py-1 text-[12px] text-ink-2 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {APP_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                  </td>

                  <td className="px-3 py-2">
                    <button
                      type="button"
                      disabled={pending || row.userId === currentUserId || !canEditStatus}
                      title={
                        row.userId === currentUserId
                          ? "You can't disable your own account."
                          : !canEditStatus
                          ? "You don't have permission to change account status."
                          : undefined
                      }
                      onClick={() =>
                        run(() => setUserStatus(row.userId, row.status === "active" ? "disabled" : "active"))
                      }
                      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                        row.status === "active"
                          ? "bg-good-soft text-good hover:brightness-95"
                          : "bg-crit-soft text-crit hover:brightness-95"
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${row.status === "active" ? "bg-good" : "bg-crit"}`}
                      />
                      {row.status === "active" ? "Active" : "Disabled"}
                    </button>
                  </td>

                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {row.businessUnits.length === 0 ? (
                        <span className="text-[12px] text-ink-3">—</span>
                      ) : (
                        row.businessUnits.map((bu) => (
                          <span
                            key={bu}
                            className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold uppercase text-ink-3"
                          >
                            {bu}
                          </span>
                        ))
                      )}
                    </div>
                  </td>

                  <td className="px-3 py-2 text-[12.5px] text-ink-2">{row.storeLabel}</td>

                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => setOpenUserId(row.userId)}
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold transition-colors ${
                        row.overrideCount > 0
                          ? "bg-accent-soft text-accent-ink hover:brightness-95"
                          : "bg-surface-2 text-ink-3 hover:text-ink"
                      }`}
                    >
                      {row.overrideCount > 0 ? `${row.overrideCount} custom` : "Role default"}
                    </button>
                  </td>

                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => setOpenUserId(row.userId)}
                      className="rounded-md border border-line px-2.5 py-1 text-[12px] text-ink-2 hover:bg-surface-2"
                    >
                      Manage
                    </button>
                  </td>
                </tr>
              )
            )}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-4 text-center text-sm text-ink-3">
                  No users match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {openUser && (
        <UserDetailDialog
          key={openUser.userId}
          user={openUser}
          open
          onOpenChange={(v) => !v && setOpenUserId(null)}
          stores={stores}
          featureKeys={featureKeys}
          rolePermissions={rolePermissions}
          overrides={overridesByUser[openUser.userId] ?? {}}
          audit={audit.filter((a) => a.target_user_id === openUser.userId)}
          canEditPermissions={canEditPermissions}
          canViewAudit={canViewAudit}
          canResetPassword={canResetPassword}
        />
      )}

      {canViewAudit && <RecentActivity audit={audit} />}
    </>
  );
}

const ACTION_LABELS: Record<string, string> = {
  "role.change": "changed the role of",
  "status.change": "changed the status of",
  "permissions.change": "changed permissions for",
  "user.create": "created",
  "user.rename": "renamed",
  "stores.change": "changed store access for",
  "business_units.change": "changed business units for",
  "password.reset": "reset the password for",
};

/** Readable labels on top of stable action keys — the audit page should read as a timeline, not a data dump. */
export function auditLine(a: AuditRow): string {
  const verb = ACTION_LABELS[a.action] ?? a.action;
  return `${a.actor_name} ${verb} ${a.target_user_name ?? "—"}`;
}

export function auditDetail(a: AuditRow): string | null {
  const d = a.detail ?? {};
  if (a.action === "role.change" && d.from && d.to) return `${d.from} → ${d.to}`;
  if (a.action === "status.change" && d.from && d.to) return `${d.from} → ${d.to}`;
  if (a.action === "permissions.change") {
    const parts: string[] = [];
    const allowed = (d.allowed as string[]) ?? [];
    const denied = (d.denied as string[]) ?? [];
    const cleared = (d.cleared as string[]) ?? [];
    if (allowed.length) parts.push(`allowed ${allowed.length}`);
    if (denied.length) parts.push(`denied ${denied.length}`);
    if (cleared.length) parts.push(`reset ${cleared.length}`);
    return parts.join(" · ") || null;
  }
  if (a.action === "stores.change") return ((d.stores as string[]) ?? []).join(", ") || "no stores";
  if (a.action === "business_units.change") return ((d.businessUnits as string[]) ?? []).join(" + ");
  if (a.action === "user.rename" && d.from && d.to) return `${d.from} → ${d.to}`;
  return null;
}

function RecentActivity({ audit }: { audit: AuditRow[] }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? audit.slice(0, 100) : audit.slice(0, 8);

  return (
    <div className="mt-8">
      <h2 className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Recent changes</h2>
      <div className="mt-2 rounded-md border border-line-soft bg-surface">
        {shown.length === 0 ? (
          <p className="px-3 py-3 text-[12.5px] text-ink-3">
            Nothing recorded yet. Every role, status, permission and scope change from here on is logged.
          </p>
        ) : (
          <ul>
            {shown.map((a) => {
              const detail = auditDetail(a);
              return (
                <li
                  key={a.id}
                  className="flex items-baseline gap-3 border-b border-line-soft px-3 py-2 text-[12.5px] last:border-0"
                >
                  <span className="flex-1 text-ink-2">
                    {auditLine(a)}
                    {detail && <span className="ml-1.5 text-ink-3">({detail})</span>}
                  </span>
                  <time className="shrink-0 font-mono text-[11px] text-ink-3" dateTime={a.created_at}>
                    {new Date(a.created_at).toISOString().slice(0, 16).replace("T", " ")}
                  </time>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {audit.length > 8 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1.5 text-[12px] text-accent hover:underline"
        >
          {expanded ? "Show less" : `Show all ${audit.length}`}
        </button>
      )}
    </div>
  );
}
