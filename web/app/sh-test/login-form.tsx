"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { testLogin, testLogout } from "./actions";

export function TestLoginForm({ loggedIn }: { loggedIn: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState("pankaj.pola@peppermint.in");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await testLogin(email, password);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed.");
    } finally {
      setBusy(false);
    }
  }

  if (loggedIn) {
    return (
      <button
        onClick={async () => {
          await testLogout();
          router.refresh();
        }}
        style={{ padding: "8px 16px" }}
      >
        Sign out (self-hosted session)
      </button>
    );
  }

  return (
    <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 320 }}>
      <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" />
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="password"
      />
      <button type="submit" disabled={busy}>
        {busy ? "Signing in…" : "Sign in via Keycloak"}
      </button>
      {error && <p style={{ color: "red" }}>{error}</p>}
    </form>
  );
}
