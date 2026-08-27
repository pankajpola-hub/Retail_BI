"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useProgressTransition } from "@/components/ui/useProgressTransition";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import {
  ACTION_CLASSES,
  ACTION_CLASS_LABELS,
  PAGE_LABELS,
  ROLE_LABELS,
  ancestorsOf,
  type ActionClass,
  type PageKey,
} from "@/lib/auth/permissions";
import { updateUserPermissionOverrides, updateUserStoreAccess, updateUserBusinessUnits } from "./actions";
import type { UserRow, FeatureKeyRow, AuditRow } from "./UsersAdmin";
import { auditLine, auditDetail } from "./UsersAdmin";
import { RenameUserButton } from "./rename-user-button";
import { ResetPasswordButton } from "./reset-password-button";

type OverrideValue = boolean | null;
type Tab = "permissions" | "scope" | "activity";

/**
 * Per-user detail. Three tabs because the three concerns have genuinely
 * different shapes: permissions is a long matrix, scope is two short
 * multi-selects, activity is a timeline.
 *
 * The permissions tab mirrors the resolver's own precedence
 * (lib/auth/access.ts) rather than re-deriving it, so what the admin sees is
 * what the app will actually do — including the non-obvious case where an
 * explicit Allow on a feature is overruled by a Deny on its page.
 */
export function UserDetailDialog({
  user,
  open,
  onOpenChange,
  stores,
  featureKeys,
  rolePermissions,
  overrides,
  audit,
  canEditPermissions,
  canViewAudit,
  canResetPassword,
}: {
  user: UserRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stores: { store_id: string; store_name: string }[];
  featureKeys: FeatureKeyRow[];
  rolePermissions: Record<string, string[]>;
  overrides: Record<string, boolean>;
  audit: AuditRow[];
  canEditPermissions: boolean;
  canViewAudit: boolean;
  canResetPassword: boolean;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("permissions");
  const [pending, startTransition] = useProgressTransition();
  const [error, setError] = useState<string | null>(null);

  // Local edits, applied on Save — a per-key round trip would make bulk work
  // (a whole page's features) unbearable and half-applied on failure.
  const [draft, setDraft] = useState<Record<string, OverrideValue>>(() => {
    const d: Record<string, OverrideValue> = {};
    for (const f of featureKeys) d[f.key] = overrides[f.key] ?? null;
    return d;
  });
  const [classFilter, setClassFilter] = useState<ActionClass | "all">("all");

  const roleKeys = useMemo(() => new Set(rolePermissions[user.role] ?? []), [rolePermissions, user.role]);

  /**
   * Same precedence as lib/auth/access.ts's decide(), against the UNSAVED
   * draft — so the admin sees what the app will actually do, live, before
   * saving. Keep the ORDER of these checks in step with decide(): the
   * ancestor-deny check must come before the exact-key check, or a stale
   * Allow on a feature reports as "Allowed" while the user is in fact
   * redirected off the denied page before reaching it.
   */
  function effective(key: string): { allowed: boolean; reason: string } {
    if (user.status === "disabled") return { allowed: false, reason: "account disabled" };
    for (const parent of ancestorsOf(key)) {
      if (draft[parent] === false) return { allowed: false, reason: "page denied" };
    }
    const exact = draft[key];
    if (exact !== null && exact !== undefined) {
      return { allowed: exact, reason: exact ? "allowed by override" : "denied by override" };
    }
    if (roleKeys.has(key)) return { allowed: true, reason: `${ROLE_LABELS[user.role]} default` };
    return { allowed: false, reason: "not in role default" };
  }

  const byPage = useMemo(() => {
    const groups = new Map<string, { page: FeatureKeyRow | null; features: FeatureKeyRow[] }>();
    for (const f of featureKeys) {
      const g = groups.get(f.page_key) ?? { page: null, features: [] };
      if (f.is_page) g.page = f;
      else g.features.push(f);
      groups.set(f.page_key, g);
    }
    return [...groups.entries()];
  }, [featureKeys]);

  const dirty = useMemo(
    () => featureKeys.some((f) => (draft[f.key] ?? null) !== (overrides[f.key] ?? null)),
    [draft, overrides, featureKeys]
  );

  const changedCount = useMemo(
    () => featureKeys.filter((f) => (draft[f.key] ?? null) !== (overrides[f.key] ?? null)).length,
    [draft, overrides, featureKeys]
  );

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

  function savePermissions() {
    const changed: Record<string, OverrideValue> = {};
    for (const f of featureKeys) {
      if ((draft[f.key] ?? null) !== (overrides[f.key] ?? null)) changed[f.key] = draft[f.key] ?? null;
    }
    run(async () => {
      await updateUserPermissionOverrides(user.userId, changed);
      onOpenChange(false);
    });
  }

  function resetAll() {
    const cleared: Record<string, OverrideValue> = {};
    for (const f of featureKeys) cleared[f.key] = null;
    setDraft(cleared);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{user.fullName}</DialogTitle>
          <DialogDescription>
            {ROLE_LABELS[user.role]}
            {user.email ? ` · ${user.email}` : ""}
            {user.status === "disabled" && " · account disabled"}
          </DialogDescription>
        </DialogHeader>

        {/* Rename and password reset live here rather than in the table row:
            both expand into an inline form, which a fixed-width table cell
            can't accommodate without the row jumping. Reusing the existing
            components unchanged — they already handle their own state. */}
        <div className="mt-2 flex flex-wrap items-start gap-x-4 gap-y-1 border-b border-line-soft pb-3 text-ink-2">
          <RenameUserButton userId={user.userId} fullName={user.fullName} />
          {canResetPassword && <ResetPasswordButton userId={user.userId} userName={user.fullName} />}
        </div>

        <div className="mt-3 flex gap-1 border-b border-line-soft">
          {(
            [
              ["permissions", "Permissions"],
              ["scope", "Stores & units"],
              ...(canViewAudit ? ([["activity", "Activity"]] as [Tab, string][]) : []),
            ] as [Tab, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`-mb-px border-b-2 px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
                tab === key
                  ? "border-accent text-ink"
                  : "border-transparent text-ink-3 hover:text-ink-2"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {error && (
          <p className="mt-2 border-l-2 border-crit bg-crit-soft px-3 py-2 text-[12px] text-crit">{error}</p>
        )}

        {user.status === "disabled" && tab === "permissions" && (
          <p className="mt-2 border-l-2 border-warn bg-warn-soft px-3 py-2 text-[12px] text-ink-2">
            This account is disabled, so everything below is denied regardless of what's set here. Re-enable it
            from the users table to make these take effect.
          </p>
        )}

        {tab === "permissions" && (
          <>
            <div className="mt-3 flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-wide text-ink-3">Filter</span>
              <div className="flex gap-1">
                <FilterChip active={classFilter === "all"} onClick={() => setClassFilter("all")}>
                  All
                </FilterChip>
                {ACTION_CLASSES.map((c) => (
                  <FilterChip key={c} active={classFilter === c} onClick={() => setClassFilter(c)}>
                    {ACTION_CLASS_LABELS[c]}
                  </FilterChip>
                ))}
              </div>
              <button
                type="button"
                onClick={resetAll}
                className="ml-auto text-[11.5px] text-ink-3 underline hover:text-ink"
              >
                Reset all to role defaults
              </button>
            </div>

            <div className="mt-2 max-h-[46vh] overflow-y-auto rounded-md border border-line-soft">
              {byPage.map(([pageKey, group]) => {
                const visible = [group.page, ...group.features].filter(
                  (f): f is FeatureKeyRow => !!f && (classFilter === "all" || f.action_class === classFilter)
                );
                if (visible.length === 0) return null;
                return (
                  <div key={pageKey}>
                    <div className="sticky top-0 z-10 border-b border-line-soft bg-surface-2 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-2">
                      {PAGE_LABELS[pageKey as PageKey] ?? pageKey}
                    </div>
                    {visible.map((f) => {
                      const eff = effective(f.key);
                      const value = draft[f.key] ?? null;
                      return (
                        <div
                          key={f.key}
                          className="flex items-center gap-3 border-b border-line-soft px-3 py-2 last:border-0"
                          style={{ paddingLeft: f.is_page ? 12 : 26 }}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[12.5px] text-ink">
                              {f.is_page ? "Access the page" : f.label}
                              {!f.is_page && f.action_class !== "view" && (
                                <span className="ml-1.5 rounded bg-surface-2 px-1 py-0.5 text-[9.5px] font-semibold uppercase text-ink-3">
                                  {ACTION_CLASS_LABELS[f.action_class]}
                                </span>
                              )}
                            </div>
                            <div
                              className={`text-[11px] ${
                                eff.allowed ? "text-ink-3" : "text-crit"
                              }`}
                            >
                              {eff.allowed ? "Allowed" : "Denied"} — {eff.reason}
                            </div>
                          </div>
                          <Segmented
                            value={value}
                            disabled={pending || !canEditPermissions}
                            onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
                          />
                        </div>
                      );
                    })}
                  </div>
                );
              })}
              {featureKeys.length === 0 && (
                <p className="px-3 py-4 text-center text-[12.5px] text-ink-3">
                  No permission keys are enforced yet.
                </p>
              )}
            </div>

            <div className="mt-3 flex items-center justify-between">
              <span className="text-[11.5px] text-ink-3">
                {dirty ? `${changedCount} unsaved change${changedCount === 1 ? "" : "s"}` : "No changes"}
              </span>
              <button
                type="button"
                disabled={!dirty || pending || !canEditPermissions}
                onClick={savePermissions}
                className="min-h-[32px] rounded-md bg-accent px-4 text-[12.5px] font-semibold text-accent-fg disabled:opacity-40"
              >
                {pending ? "Saving…" : "Save permissions"}
              </button>
            </div>
          </>
        )}

        {tab === "scope" && (
          <ScopeTab user={user} stores={stores} pending={pending} run={run} onDone={() => onOpenChange(false)} />
        )}

        {tab === "activity" && (
          <div className="mt-3 max-h-[50vh] overflow-y-auto rounded-md border border-line-soft">
            {audit.length === 0 ? (
              <p className="px-3 py-4 text-center text-[12.5px] text-ink-3">
                No recorded changes for this user yet.
              </p>
            ) : (
              <ul>
                {audit.map((a) => {
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
        )}
      </DialogContent>
    </Dialog>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-2.5 py-0.5 text-[11.5px] font-medium transition-colors ${
        active ? "bg-accent text-accent-fg" : "bg-surface-2 text-ink-3 hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

/** Default / Allow / Deny. "Default" clears the override and defers to the role. */
function Segmented({
  value,
  disabled,
  onChange,
}: {
  value: OverrideValue;
  disabled: boolean;
  onChange: (v: OverrideValue) => void;
}) {
  const opts: { label: string; v: OverrideValue; activeClass: string }[] = [
    { label: "Default", v: null, activeClass: "bg-surface-2 text-ink" },
    { label: "Allow", v: true, activeClass: "bg-good-soft text-good" },
    { label: "Deny", v: false, activeClass: "bg-crit-soft text-crit" },
  ];
  return (
    <div className="flex shrink-0 overflow-hidden rounded-md border border-line">
      {opts.map((o, i) => (
        <button
          key={String(o.v)}
          type="button"
          disabled={disabled}
          onClick={() => onChange(o.v)}
          className={`px-2.5 py-1 text-[11px] font-semibold transition-colors disabled:opacity-50 ${
            i > 0 ? "border-l border-line" : ""
          } ${value === o.v ? o.activeClass : "bg-surface text-ink-3 hover:bg-surface-2"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ScopeTab({
  user,
  stores,
  pending,
  run,
  onDone,
}: {
  user: UserRow;
  stores: { store_id: string; store_name: string }[];
  pending: boolean;
  run: (fn: () => Promise<void>) => void;
  onDone: () => void;
}) {
  const [storeIds, setStoreIds] = useState<string[]>(user.storeIds);
  const [units, setUnits] = useState<string[]>(user.businessUnits);

  const wideOpen = user.role === "super_admin" || user.role === "ho_admin";

  function toggle(list: string[], setList: (v: string[]) => void, value: string) {
    setList(list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);
  }

  return (
    <div className="mt-3 flex flex-col gap-5">
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Business units</div>
        <p className="mt-0.5 text-[11.5px] text-ink-3">
          Checked before role and store access — a user with none of these can't reach any page.
        </p>
        <div className="mt-2 flex gap-2">
          {(["retail", "ecomm"] as const).map((bu) => (
            <label
              key={bu}
              className="flex cursor-pointer items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-[12.5px]"
            >
              <input
                type="checkbox"
                checked={units.includes(bu)}
                onChange={() => toggle(units, setUnits, bu)}
                disabled={pending}
              />
              <span className="uppercase">{bu}</span>
            </label>
          ))}
        </div>
      </div>

      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Store access</div>
        {wideOpen ? (
          <p className="mt-0.5 text-[11.5px] text-ink-3">
            {ROLE_LABELS[user.role]} sees every store regardless of what's set here
            (core.fn_user_store_ids()), so these grants only take effect if the role changes later.
          </p>
        ) : (
          <p className="mt-0.5 text-[11.5px] text-ink-3">
            No stores selected means this user sees no store data at all.
          </p>
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          {stores.map((s) => (
            <label
              key={s.store_id}
              className="flex cursor-pointer items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-[12.5px]"
            >
              <input
                type="checkbox"
                checked={storeIds.includes(s.store_id)}
                onChange={() => toggle(storeIds, setStoreIds, s.store_id)}
                disabled={pending}
              />
              {s.store_name}
            </label>
          ))}
        </div>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          disabled={pending || units.length === 0}
          title={units.length === 0 ? "A user needs at least one business unit." : undefined}
          onClick={() =>
            run(async () => {
              await updateUserBusinessUnits(user.userId, units as ("retail" | "ecomm")[]);
              await updateUserStoreAccess(user.userId, storeIds);
              onDone();
            })
          }
          className="min-h-[32px] rounded-md bg-accent px-4 text-[12.5px] font-semibold text-accent-fg disabled:opacity-40"
        >
          {pending ? "Saving…" : "Save scope"}
        </button>
      </div>
    </div>
  );
}
