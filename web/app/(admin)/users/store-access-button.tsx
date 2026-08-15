"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { updateUserStoreAccess } from "./actions";

type Store = { store_id: string; store_name: string };

type State =
  | { status: "idle" }
  | { status: "editing"; selected: string[] }
  | { status: "saving"; selected: string[] }
  | { status: "error"; selected: string[]; message: string };

// User feedback #16a ("allocate the location"): edits a user's
// core.user_store_access grants (migration 0003 — that table already
// existed, this is the first admin UI to change it after invite time).
// Only matters for ebo_manager/regional_manager (fn_user_store_ids()
// returns every store for ho_admin/super_admin regardless, per the note on
// the Users page), but shown for every user — an admin re-provisioning
// someone into a store-scoped role shouldn't need a different path.
export function StoreAccessButton({
  userId,
  userName,
  stores,
  currentStoreIds,
}: {
  userId: string;
  userName: string;
  stores: Store[];
  currentStoreIds: string[];
}) {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "idle" });

  if (state.status === "idle") {
    return (
      <button
        type="button"
        onClick={() => setState({ status: "editing", selected: currentStoreIds })}
        className="text-[11px] underline"
      >
        Edit stores
      </button>
    );
  }

  const selected = state.selected;
  const saving = state.status === "saving";

  function toggle(storeId: string) {
    setState((prev) => {
      if (prev.status !== "editing" && prev.status !== "error") return prev;
      const next = prev.selected.includes(storeId)
        ? prev.selected.filter((id) => id !== storeId)
        : [...prev.selected, storeId];
      return { status: "editing", selected: next };
    });
  }

  async function onSave() {
    setState({ status: "saving", selected });
    try {
      await updateUserStoreAccess(userId, selected);
      setState({ status: "idle" });
      router.refresh();
    } catch (err) {
      setState({
        status: "error",
        selected,
        message: err instanceof Error ? err.message : "Update failed.",
      });
    }
  }

  return (
    <div className="mt-1 flex flex-col gap-1.5 border-l-2 border-line-soft bg-surface-2 px-3 py-2 text-[12.5px]">
      <span>
        Store access for <strong>{userName}</strong>
      </span>
      <div className="flex flex-col gap-1">
        {stores.length === 0 && <span className="text-ink-3">No stores in core.stores yet.</span>}
        {stores.map((s) => (
          <label key={s.store_id} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={selected.includes(s.store_id)}
              onChange={() => toggle(s.store_id)}
              disabled={saving}
            />
            {s.store_id} — {s.store_name}
          </label>
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
