"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function login(formData: FormData) {
  // .trim() guards against the single most common real-world failure mode
  // here: a stray leading/trailing space from copy-pasting the email or
  // password, which silently makes an auth failure look identical to an
  // actually-wrong password.
  const email = (formData.get("email") as string).trim();
  const password = (formData.get("password") as string).trim();
  const next = (formData.get("next") as string) || "/";

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}&email=${encodeURIComponent(email)}`);
  }
  redirect(next);
}
