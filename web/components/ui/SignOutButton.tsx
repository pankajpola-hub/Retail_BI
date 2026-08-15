"use client";

import { useRouter } from "next/navigation";
import { signOutAction } from "@/lib/auth/actions";

export function SignOutButton({ label = "Sign out" }: { label?: string }) {
  const router = useRouter();

  async function signOut() {
    await signOutAction();
    router.push("/login");
    router.refresh();
  }

  return (
    // p-2 -m-2 grows the tap target to ~40px without shifting surrounding
    // layout — the negative margin cancels the padding's visual footprint.
    <button onClick={signOut} className="-m-2 p-2 text-[13px] text-ink-3 underline">
      {label}
    </button>
  );
}
