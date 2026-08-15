"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { inviteUser } from "./actions";

type Store = { store_id: string; store_name: string };
type Role = "super_admin" | "ho_admin" | "regional_manager" | "ebo_manager" | "marketing";

const ROLES: { value: Role; label: string; needsStores: boolean }[] = [
  { value: "ebo_manager", label: "EBO Manager", needsStores: true },
  { value: "regional_manager", label: "Regional Manager", needsStores: true },
  { value: "marketing", label: "Marketing", needsStores: false },
  { value: "ho_admin", label: "HO Admin", needsStores: false },
  { value: "super_admin", label: "Super Admin", needsStores: false },
];

export function InviteUserForm({ stores }: { stores: Store[] }) {
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("ebo_manager");
  const [storeIds, setStoreIds] = useState<string[]>([]);
  const [status, setStatus] = useState<
    { state: "idle" } | { state: "saving" } | { state: "error"; message: string } | { state: "done" }
  >({ state: "idle" });

  const needsStores = ROLES.find((r) => r.value === role)?.needsStores ?? false;

  function toggleStore(storeId: string) {
    setStoreIds((prev) =>
      prev.includes(storeId) ? prev.filter((id) => id !== storeId) : [...prev, storeId]
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus({ state: "saving" });
    try {
      await inviteUser({ email, fullName, role, storeIds: needsStores ? storeIds : [] });
      setStatus({ state: "done" });
      setFullName("");
      setEmail("");
      setStoreIds([]);
      router.refresh();
    } catch (err) {
      setStatus({ state: "error", message: err instanceof Error ? err.message : "Invite failed." });
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 border border-line-soft p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          Full name
          <input
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
            className="border border-line px-3 py-2 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="border border-line px-3 py-2 text-sm"
          />
        </label>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        Role
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
          className="border border-line px-3 py-2 text-sm"
        >
          {ROLES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </label>

      {needsStores && (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
            Store access
          </legend>
          {stores.length === 0 && (
            <p className="text-[12.5px] text-ink-3">No stores in core.stores yet.</p>
          )}
          {stores.map((s) => (
            <label key={s.store_id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={storeIds.includes(s.store_id)}
                onChange={() => toggleStore(s.store_id)}
              />
              {s.store_id} — {s.store_name}
            </label>
          ))}
        </fieldset>
      )}

      <button
        type="submit"
        disabled={status.state === "saving"}
        className="mt-1 self-start bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
      >
        {status.state === "saving" ? "Sending invite…" : "Send invite"}
      </button>

      {status.state === "error" && (
        <p className="border-l-2 border-crit bg-crit-soft px-3 py-2 text-sm text-ink-2">
          {status.message}
        </p>
      )}
      {status.state === "done" && (
        <p className="border-l-2 border-good bg-good-soft px-3 py-2 text-sm text-ink-2">
          Invite sent. They'll get an email to set their password.
        </p>
      )}
    </form>
  );
}
