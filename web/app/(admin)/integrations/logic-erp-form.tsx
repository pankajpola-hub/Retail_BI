"use client";

import { useState } from "react";
import { saveLogicErpCredentials, testLogicErpConnection } from "./actions";

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
        <input
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="192.168.1.233"
          required
          className="min-h-[36px] border border-line bg-surface px-3 py-1.5 text-sm"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Port</span>
        <input
          type="number"
          value={port}
          onChange={(e) => setPort(e.target.value)}
          required
          className="min-h-[36px] w-32 border border-line bg-surface px-3 py-1.5 text-sm"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Database name</span>
        <input
          value={databaseName}
          onChange={(e) => setDatabaseName(e.target.value)}
          required
          className="min-h-[36px] border border-line bg-surface px-3 py-1.5 text-sm"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">DB user</span>
        <input
          value={dbUser}
          onChange={(e) => setDbUser(e.target.value)}
          required
          className="min-h-[36px] border border-line bg-surface px-3 py-1.5 text-sm"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
          DB password
          {existing && <span className="ml-1 normal-case text-ink-3">(leave blank to keep the current one)</span>}
        </span>
        <input
          type="password"
          value={dbPassword}
          onChange={(e) => {
            setDbPassword(e.target.value);
            setTestStatus({ state: "idle" }); // any edit invalidates the last test result
          }}
          autoComplete="new-password"
          required={!existing}
          className="min-h-[36px] border border-line bg-surface px-3 py-1.5 text-sm"
        />
      </label>

      <div className="mt-1 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onTest}
          disabled={testStatus.state === "testing" || !host || !databaseName || !dbUser}
          className="border border-line px-4 py-2 text-sm font-semibold text-ink-2 disabled:opacity-60"
        >
          {testStatus.state === "testing" ? "Testing…" : "Test connection"}
        </button>
        <button
          type="submit"
          disabled={saveStatus.state === "saving"}
          className="bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
        >
          {saveStatus.state === "saving" ? "Saving…" : "Save"}
        </button>
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
