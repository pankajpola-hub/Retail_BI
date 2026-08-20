"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { renameUser } from "./actions";
import { Input } from "@/components/ui/input";

type State =
  | { status: "idle" }
  | { status: "editing"; value: string }
  | { status: "saving"; value: string }
  | { status: "error"; value: string; message: string };

// User feedback #15 ("give me option to rename the users in users page"):
// click-to-edit inline, replacing the name text with an input + Save/Cancel.
// renameUser() (actions.ts) updates both Keycloak (self-hosted only) and
// core.profiles.full_name — see that function's header comment for why the
// Keycloak write is conditional.
export function RenameUserButton({ userId, fullName }: { userId: string; fullName: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "idle" });

  if (state.status === "idle") {
    return (
      <button
        type="button"
        onClick={() => setState({ status: "editing", value: fullName })}
        className="text-[11px] underline"
        aria-label={`Rename ${fullName}`}
        title="Rename"
      >
        ✎ Rename
      </button>
    );
  }

  const saving = state.status === "saving";

  async function onSave() {
    if (state.status !== "editing" && state.status !== "error") return;
    const value = state.value.trim();
    if (!value) {
      setState({ status: "error", value: state.value, message: "Name can't be empty." });
      return;
    }
    setState({ status: "saving", value });
    try {
      await renameUser(userId, value);
      setState({ status: "idle" });
      router.refresh();
    } catch (err) {
      setState({
        status: "error",
        value,
        message: err instanceof Error ? err.message : "Rename failed.",
      });
    }
  }

  return (
    <span className="flex flex-col items-end gap-1">
      <span className="flex items-center gap-1">
        <Input
          value={"value" in state ? state.value : fullName}
          onChange={(e) =>
            setState((prev) =>
              prev.status === "editing" || prev.status === "error"
                ? { status: "editing", value: e.target.value }
                : prev
            )
          }
          disabled={saving}
          autoFocus
          className="min-h-0 w-auto py-1 text-[12.5px]"
        />
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="text-[11px] underline disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => setState({ status: "idle" })}
          disabled={saving}
          className="text-[11px] underline disabled:opacity-60"
        >
          Cancel
        </button>
      </span>
      {state.status === "error" && (
        <span className="max-w-[220px] text-right text-[11px] text-crit">{state.message}</span>
      )}
    </span>
  );
}
