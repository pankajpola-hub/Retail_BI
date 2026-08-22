"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createUser } from "./actions";
import { Input, Select, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

type Store = { store_id: string; store_name: string };
type Role = "super_admin" | "ho_admin" | "regional_manager" | "ebo_manager" | "marketing";
type BusinessUnit = "retail" | "ecomm";

const ROLES: { value: Role; label: string; needsStores: boolean }[] = [
  { value: "ebo_manager", label: "EBO Manager", needsStores: true },
  { value: "regional_manager", label: "Regional Manager", needsStores: true },
  { value: "marketing", label: "Marketing", needsStores: false },
  { value: "ho_admin", label: "HO Admin", needsStores: false },
  { value: "super_admin", label: "Super Admin", needsStores: false },
];

// 0061_business_unit.sql — Ecomm has no pages yet (Uniware integration not
// built), but the grant already exists so an admin can provision it ahead of
// time. Retail checked by default: every page in the app today is Retail.
const BUSINESS_UNITS: { value: BusinessUnit; label: string }[] = [
  { value: "retail", label: "Retail (EBO stores)" },
  { value: "ecomm", label: "Ecomm" },
];

/**
 * Creates a fully working account in one step — no separate "Reset
 * password" afterward. Named/worded as creation, not an invite: no email is
 * sent (SMTP isn't configured on this project), so there's nothing to
 * "invite" — the admin sets the password right here and hands the
 * credentials to the user directly.
 */
export function InviteUserForm({ stores }: { stores: Store[] }) {
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("ebo_manager");
  const [storeIds, setStoreIds] = useState<string[]>([]);
  const [businessUnits, setBusinessUnits] = useState<BusinessUnit[]>(["retail"]);
  const [status, setStatus] = useState<
    { state: "idle" } | { state: "saving" } | { state: "error"; message: string } | { state: "done" }
  >({ state: "idle" });

  const needsStores = ROLES.find((r) => r.value === role)?.needsStores ?? false;

  function toggleStore(storeId: string) {
    setStoreIds((prev) =>
      prev.includes(storeId) ? prev.filter((id) => id !== storeId) : [...prev, storeId]
    );
  }

  function toggleBusinessUnit(unit: BusinessUnit) {
    setBusinessUnits((prev) =>
      prev.includes(unit) ? prev.filter((u) => u !== unit) : [...prev, unit]
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus({ state: "saving" });
    try {
      await createUser({ email, fullName, password, role, storeIds: needsStores ? storeIds : [], businessUnits });
      setStatus({ state: "done" });
      setFullName("");
      setEmail("");
      setPassword("");
      setStoreIds([]);
      setBusinessUnits(["retail"]);
      router.refresh();
    } catch (err) {
      setStatus({ state: "error", message: err instanceof Error ? err.message : "Couldn't create the user." });
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 border border-line-soft p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Label className="flex flex-col gap-1">
          Full name
          <Input value={fullName} onChange={(e) => setFullName(e.target.value)} required />
        </Label>
        <Label className="flex flex-col gap-1">
          Email
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Label>
      </div>

      <Label className="flex flex-col gap-1">
        Password
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={8}
          required
          autoComplete="new-password"
        />
      </Label>

      <Label className="flex flex-col gap-1">
        Role
        <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {ROLES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </Select>
      </Label>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
          Business unit
        </legend>
        {BUSINESS_UNITS.map((u) => (
          <label key={u.value} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={businessUnits.includes(u.value)}
              onChange={() => toggleBusinessUnit(u.value)}
            />
            {u.label}
          </label>
        ))}
      </fieldset>

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

      <Button
        type="submit"
        disabled={status.state === "saving" || businessUnits.length === 0}
        className="mt-1 self-start"
      >
        {status.state === "saving" ? "Creating…" : "Create user"}
      </Button>

      {status.state === "error" && (
        <p className="border-l-2 border-crit bg-crit-soft px-3 py-2 text-sm text-ink-2">
          {status.message}
        </p>
      )}
      {status.state === "done" && (
        <p className="border-l-2 border-good bg-good-soft px-3 py-2 text-sm text-ink-2">
          User created and ready to sign in — share the email and password with them yourself.
        </p>
      )}
    </form>
  );
}
