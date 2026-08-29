"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { updateUserPageOverrides } from "./actions";
import { PAGE_KEYS, PAGE_LABELS, type PageKey } from "@/lib/auth/permissions";

// PageKey/PAGE_KEYS/PAGE_LABELS used to be hand-rolled here — a 7-page union
// that silently drifted from the 11 pages requirePageAccess() actually
// gates, so Movement, Workspace, Configurations and Ecomm had no admin
// control at all. Now imported from lib/auth/permissions.ts, the one shared,
// no-server-only module this and lib/auth/roles.ts both read, so the two
// can't diverge again (see that file's own header for the full story).

// null = "no override, use the role default"; true/false = explicit grant/revoke.
type OverrideValue = boolean | null;

type State =
  | { status: "idle" }
  | { status: "editing"; values: Record<PageKey, OverrideValue> }
  | { status: "saving"; values: Record<PageKey, OverrideValue> }
  | { status: "error"; values: Record<PageKey, OverrideValue>; message: string };

// User feedback #16b ("the menu pages rights"): per-user overrides on top of
// the role-based nav/page defaults, written to core.user_page_overrides
// (migration 0035). "Default" here means "defer to this user's role" — see
// PAGE_ROLE_DEFAULTS in lib/auth/roles.ts for what that resolves to per
// role. All 11 pages wired up to requirePageAccess() are shown (imported
// from lib/auth/permissions.ts, see above) — a page.tsx not on that list
// (my-store, campaigns, and anything without a nav entry) still only
// respects role defaults and has no per-user override here.
export function PageAccessButton({
  userId,
  userName,
  currentOverrides,
}: {
  userId: string;
  userName: string;
  currentOverrides: Partial<Record<PageKey, boolean>>;
}) {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "idle" });

  function toValues(): Record<PageKey, OverrideValue> {
    const values = {} as Record<PageKey, OverrideValue>;
    for (const key of PAGE_KEYS) {
      values[key] = currentOverrides[key] ?? null;
    }
    return values;
  }

  if (state.status === "idle") {
    return (
      <button type="button" onClick={() => setState({ status: "editing", values: toValues() })} className="text-[11px] underline">
        Page rights
      </button>
    );
  }

  const values = state.values;
  const saving = state.status === "saving";

  function setValue(key: PageKey, value: OverrideValue) {
    setState((prev) => {
      if (prev.status !== "editing" && prev.status !== "error") return prev;
      return { status: "editing", values: { ...prev.values, [key]: value } };
    });
  }

  async function onSave() {
    setState({ status: "saving", values });
    try {
      await updateUserPageOverrides(userId, values);
      setState({ status: "idle" });
      router.refresh();
    } catch (err) {
      setState({
        status: "error",
        values,
        message: err instanceof Error ? err.message : "Update failed.",
      });
    }
  }

  return (
    <div className="mt-1 flex flex-col gap-1.5 border-l-2 border-line-soft bg-surface-2 px-3 py-2 text-[12.5px]">
      <span>
        Page rights for <strong>{userName}</strong> — overrides the role default one way or the other;
        "Default" clears the override.
      </span>
      <div className="flex flex-col gap-1.5">
        {PAGE_KEYS.map((key) => (
          <div key={key} className="flex items-center justify-between gap-2">
            <span className="text-ink-2">{PAGE_LABELS[key]}</span>
            <span className="flex items-center gap-1">
              {(
                [
                  { label: "Deny", v: false as OverrideValue },
                  { label: "Default", v: null as OverrideValue },
                  { label: "Allow", v: true as OverrideValue },
                ] as const
              ).map((opt) => (
                <button
                  key={String(opt.v)}
                  type="button"
                  disabled={saving}
                  onClick={() => setValue(key, opt.v)}
                  className={`border px-2 py-0.5 text-[11px] ${
                    values[key] === opt.v
                      ? "border-accent bg-accent text-accent-fg"
                      : "border-line text-ink-2"
                  } disabled:opacity-60`}
                >
                  {opt.label}
                </button>
              ))}
            </span>
          </div>
        ))}
      </div>
      <span className="flex items-center gap-2">
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="self-start text-[11px] underline disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => setState({ status: "idle" })}
          disabled={saving}
          className="self-start text-[11px] underline disabled:opacity-60"
        >
          Cancel
        </button>
      </span>
      {state.status === "error" && <span className="text-[11px] text-crit">{state.message}</span>}
    </div>
  );
}
