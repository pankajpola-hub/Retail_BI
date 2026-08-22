"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { updateUserBusinessUnits } from "./actions";

type BusinessUnit = "retail" | "ecomm";

const BUSINESS_UNITS: { value: BusinessUnit; label: string }[] = [
  { value: "retail", label: "Retail (EBO stores)" },
  { value: "ecomm", label: "Ecomm" },
];

type State =
  | { status: "idle" }
  | { status: "editing"; selected: BusinessUnit[] }
  | { status: "saving"; selected: BusinessUnit[] }
  | { status: "error"; selected: BusinessUnit[]; message: string };

// 0061_business_unit.sql — same "Edit ___" / inline panel pattern as
// StoreAccessButton, for the OTHER dimension of access: not which stores
// within a business, but which business (Retail vs Ecomm) at all. Checked
// before role/store in requirePageAccess/AppShell — see PAGE_BUSINESS_UNIT
// in lib/auth/roles.ts.
export function BusinessUnitButton({
  userId,
  userName,
  currentBusinessUnits,
}: {
  userId: string;
  userName: string;
  currentBusinessUnits: BusinessUnit[];
}) {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "idle" });

  if (state.status === "idle") {
    return (
      <button
        type="button"
        onClick={() => setState({ status: "editing", selected: currentBusinessUnits })}
        className="text-[11px] underline"
      >
        Edit business units
      </button>
    );
  }

  const selected = state.selected;
  const saving = state.status === "saving";

  function toggle(unit: BusinessUnit) {
    setState((prev) => {
      if (prev.status !== "editing" && prev.status !== "error") return prev;
      const next = prev.selected.includes(unit)
        ? prev.selected.filter((u) => u !== unit)
        : [...prev.selected, unit];
      return { status: "editing", selected: next };
    });
  }

  async function onSave() {
    if (selected.length === 0) {
      setState({ status: "error", selected, message: "Select at least one business unit." });
      return;
    }
    setState({ status: "saving", selected });
    try {
      await updateUserBusinessUnits(userId, selected);
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
        Business units for <strong>{userName}</strong>
      </span>
      <div className="flex flex-col gap-1">
        {BUSINESS_UNITS.map((u) => (
          <label key={u.value} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={selected.includes(u.value)}
              onChange={() => toggle(u.value)}
              disabled={saving}
            />
            {u.label}
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
