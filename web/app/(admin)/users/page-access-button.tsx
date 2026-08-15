"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { updateUserPageOverrides } from "./actions";

type PageKey =
  | "network"
  | "stock-details"
  | "footfall"
  | "targets"
  | "users"
  | "integrations"
  | "data-upload";

const PAGE_KEYS: PageKey[] = [
  "network",
  "stock-details",
  "footfall",
  "targets",
  "users",
  "integrations",
  "data-upload",
];

const PAGE_LABELS: Record<PageKey, string> = {
  network: "Network",
  "stock-details": "Stock Details",
  footfall: "Footfall",
  targets: "Targets",
  users: "Users",
  integrations: "Integrations",
  "data-upload": "Data Upload",
};

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
// role. Only the 7 pages wired up to requirePageAccess()/TopNav's per-user
// filtering are shown — see that file's requirePageAccess doc comment for
// which pages still only respect role defaults (my-store, campaigns, and
// any other page.tsx not listed there).
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
                      ? "border-accent bg-accent text-white"
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
