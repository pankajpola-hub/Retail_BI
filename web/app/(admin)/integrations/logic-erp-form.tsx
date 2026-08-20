"use client";

import { useState } from "react";
import { saveLogicErpCredentials, testLogicErpConnection } from "./actions";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

type Existing = {
  host: string;
  port: number;
  databaseName: string;
  dbUser: string;
  updatedAt: string;
} | null;

type SaveStatus = { state: "idle" } | { state: "saving" } | { state: "error"; message: string } | { state: "done" };
type TestStatus =
  | { state: "idle" }
  | { state: "testing" }
  | { state: "success"; message: string }
  | { state: "failure"; message: string };

export function LogicErpForm({ existing }: { existing: Existing }) {
  const [host, setHost] = useState(existing?.host ?? "");
  const [port, setPort] = useState(String(existing?.port ?? 1433));
  const [databaseName, setDatabaseName] = useState(existing?.databaseName ?? "");
  const [dbUser, setDbUser] = useState(existing?.dbUser ?? "");
  const [dbPassword, setDbPassword] = useState("");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ state: "idle" });
  const [testStatus, setTestStatus] = useState<TestStatus>({ state: "idle" });

  const currentInput = { host, port: Number(port), databaseName, dbUser, dbPassword };

  async function onTest() {
    setTestStatus({ state: "testing" });
    try {
      const result = await testLogicErpConnection(currentInput);
      setTestStatus(
        result.ok ? { state: "success", message: result.message } : { state: "failure", message: result.message }
      );
    } catch (err) {
      setTestStatus({ state: "failure", message: err instanceof Error ? err.message : "Test failed." });
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaveStatus({ state: "saving" });
    try {
      await saveLogicErpCredentials(currentInput);
      setSaveStatus({ state: "done" });
      setDbPassword(""); // never leave the plaintext sitting in the field after a successful save
      setTestStatus({ state: "idle" }); // stale result for a password field that's now been cleared
    } catch (err) {
      setSaveStatus({ state: "error", message: err instanceof Error ? err.message : "Save failed." });
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 border border-line-soft p-4">
      {existing && (
        <p className="text-[12px] text-ink-3">
          Already configured — last updated{" "}
          {new Date(existing.updatedAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}.
          Saving below overwrites it.
        </p>
      )}

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Host / IP</span>
        <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.233" required />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Port</span>
        <Input type="number" value={port} onChange={(e) => setPort(e.target.value)} required className="w-32" />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Database name</span>
        <Input value={databaseName} onChange={(e) => setDatabaseName(e.target.value)} required />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">DB user</span>
        <Input value={dbUser} onChange={(e) => setDbUser(e.target.value)} required />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
          DB password
          {existing && <span className="ml-1 normal-case text-ink-3">(leave blank to keep the current one)</span>}
        </span>
        <Input
          type="password"
          value={dbPassword}
          onChange={(e) => {
            setDbPassword(e.target.value);
            setTestStatus({ state: "idle" }); // any edit invalidates the last test result
          }}
          autoComplete="new-password"
          required={!existing}
        />
      </label>

      <div className="mt-1 flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={onTest}
          disabled={testStatus.state === "testing" || !host || !databaseName || !dbUser}
        >
          {testStatus.state === "testing" ? "Testing…" : "Test connection"}
        </Button>
        <Button type="submit" disabled={saveStatus.state === "saving"}>
          {saveStatus.state === "saving" ? "Saving…" : "Save"}
        </Button>
      </div>

      {testStatus.state === "success" && (
        <p className="border-l-2 border-good bg-good-soft px-3 py-2 text-sm text-ink-2">
          {testStatus.message}
        </p>
      )}
      {testStatus.state === "failure" && (
        <p className="border-l-2 border-crit bg-crit-soft px-3 py-2 text-sm text-ink-2">{testStatus.message}</p>
      )}

      {saveStatus.state === "error" && (
        <p className="border-l-2 border-crit bg-crit-soft px-3 py-2 text-sm text-ink-2">{saveStatus.message}</p>
      )}
      {saveStatus.state === "done" && (
        <p className="border-l-2 border-good bg-good-soft px-3 py-2 text-sm text-ink-2">
          Saved. The password is encrypted at rest and never shown again in this form.
        </p>
      )}
    </form>
  );
}
