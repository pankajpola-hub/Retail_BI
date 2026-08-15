"use server";

import { redirect } from "next/navigation";
import { loginWithPassword, setSessionCookies } from "@/lib/keycloak/session";

export async function login(formData: FormData) {
  // .trim() guards against the single most common real-world failure mode
  // here: a stray leading/trailing space from copy-pasting the email or
  // password, which silently makes an auth failure look identical to an
  // actually-wrong password.
  const email = (formData.get("email") as string).trim();
  const password = (formData.get("password") as string).trim();
  const next = (formData.get("next") as string) || "/";

  try {
    const tokens = await loginWithPassword(email, password);
    await setSessionCookies(tokens);
  } catch (err) {
    const raw = err instanceof Error ? err.message : "Login failed.";
    // Keycloak returns "Account is not fully set up" for an account carrying
    // a pending required action (e.g. UPDATE_PASSWORD) — it refuses the
    // password grant entirely in that state. Passed through verbatim it read
    // almost identically to this app's OWN "not provisioned" copy, and cost
    // a long, wrong-headed debugging session to tell apart. Translate it into
    // something that names the real situation and the real remedy.
    const message =
      raw === "Account is not fully set up"
        ? "This account has a pending action in Keycloak (usually a forced password change) and can't sign in until it's cleared. Ask a Super Admin to reset the password from the Users page."
        : raw;
    redirect(`/login?error=${encodeURIComponent(message)}&email=${encodeURIComponent(email)}`);
  }
  redirect(next);
}
