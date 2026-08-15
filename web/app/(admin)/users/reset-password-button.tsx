"use client";

import { useState } from "react";
import { setUserPassword } from "./actions";

type State =
  | { status: "idle" }
  | { status: "editing" }
  | { status: "working" }
  | { status: "done" }
  | { status: "error"; message: string };

// Admin types the new password directly and it replaces the old one
// immediately — no generated/temporary password, nothing shown or copied.
// See users/actions.ts setUserPassword for the server side.
export function ResetPasswordButton({ userId, userName }: { userId: string; userName: string }) {
  const [state, setState] = useState<State>({ status: "idle" });
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setState({ status: "error", message: "Password must be at least 8 characters." });
      return;
    }
    setState({ status: "working" });
    try {
      await setUserPassword(userId, password);
      setPassword("");
      setState({ status: "done" });
    } catch (err) {
      setState({ status: "error", message: err instanceof Error ? err.message : "Failed to set password." });
    }
  }

  if (state.status === "done") {
    return (
      <div className="mt-1 flex flex-col gap-1 border-l-2 border-good bg-good-soft px-3 py-2 text-[12.5px]">
        <span>
          Password updated for <strong>{userName}</strong>.
        </span>
        <button
          type="button"
          onClick={() => setState({ status: "idle" })}
          className="mt-1 self-start text-[11px] underline"
        >
          Dismiss
        </button>
      </div>
    );
  }

  if (state.status === "editing" || state.status === "working" || state.status === "error") {
    return (
      <form
        onSubmit={onSubmit}
        className="mt-1 flex flex-col items-end gap-1 border-l-2 border-warn bg-warn-soft px-3 py-2 text-[12.5px]"
      >
        <span>
          New password for <strong>{userName}</strong>:
        </span>
        <span className="flex w-full items-center gap-1">
          <input
            type={reveal ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            minLength={8}
            required
            disabled={state.status === "working"}
            className="min-w-0 flex-1 bg-surface px-2 py-1 font-mono text-sm"
          />
          <button
            type="button"
            onClick={() => setReveal((r) => !r)}
            className="text-[11px] underline"
          >
            {reveal ? "Hide" : "Show"}
          </button>
        </span>
        {state.status === "error" && <span className="text-right text-[11px] text-crit">{state.message}</span>}
        <span className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              setPassword("");
              setState({ status: "idle" });
            }}
            disabled={state.status === "working"}
            className="text-[11px] underline disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={state.status === "working"}
            className="text-[11px] underline disabled:opacity-60"
          >
            {state.status === "working" ? "Setting…" : "Set password"}
          </button>
        </span>
      </form>
    );
  }

  return (
    <span className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => setState({ status: "editing" })}
        className="text-[11px] underline"
      >
        Reset password
      </button>
    </span>
  );
}
