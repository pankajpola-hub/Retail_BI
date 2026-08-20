"use server";

import { createClient } from "@/lib/supabase/server";

/**
 * Sign-out. SignOutButton is a Client Component and can't touch cookies()
 * directly, so this Server Action does it.
 */
export async function signOutAction() {
  const supabase = await createClient();
  await supabase.auth.signOut();
}
