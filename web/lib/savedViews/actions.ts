"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/data/client";
import type { DataClient } from "@/lib/data/client";

/**
 * Saved filter views — Phase 1 of the faceted-filtering system
 * (FacetFilterBar.tsx). Same thin owner-scoped-RLS pattern as
 * lib/exports/actions.ts / lib/alerts/actions.ts: ops.saved_filter_views
 * is owner-only RLS (migration 0078), so these call the caller's own
 * RLS-scoped client, never the admin client.
 *
 * `state` is opaque JSON from the caller's point of view — FacetFilterBar
 * owns its own shape ({ facets, search, conditions, groupBy }) and this
 * layer just stores/retrieves it per (owner, page_key, name).
 */

export type SavedFilterView = {
  id: string;
  name: string;
  state: unknown;
  createdAt: string;
};

type SavedFilterViewRow = {
  id: string;
  name: string;
  state: unknown;
  created_at: string;
};

async function requireCallerId(supabase: DataClient): Promise<string> {
  const {
    data: { user: caller },
  } = await supabase.auth.getUser();
  if (!caller) throw new Error("Not authenticated.");
  return caller.id;
}

/** The caller's own saved views for one page — RLS already narrows this to owner_id = caller. */
export async function listMySavedViews(pageKey: string): Promise<SavedFilterView[]> {
  const supabase = await createClient();
  await requireCallerId(supabase);

  const { data, error } = await supabase
    .schema("ops")
    .from<SavedFilterViewRow>("saved_filter_views")
    .select("id, name, state, created_at")
    .eq("page_key", pageKey)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => ({ id: row.id, name: row.name, state: row.state, createdAt: row.created_at }));
}

export async function createSavedView(pageKey: string, name: string, state: unknown): Promise<void> {
  const supabase = await createClient();
  const ownerId = await requireCallerId(supabase);

  const trimmedName = name.trim();
  if (!trimmedName) throw new Error("Name is required.");

  // Upsert on (owner_id, page_key, name) — the migration's unique
  // constraint enforces this too; saving under an existing name updates it
  // rather than erroring, matching how "save" reasonably behaves here.
  const { error } = await supabase
    .schema("ops")
    .from("saved_filter_views")
    .upsert({ owner_id: ownerId, page_key: pageKey, name: trimmedName, state }, { onConflict: "owner_id,page_key,name" });
  if (error) throw new Error(error.message);
  revalidatePath("/movement");
}

/** RLS (saved_filter_views_owner_all) already restricts this to the owner — no app-side ownership re-check needed beyond requireCallerId. */
export async function deleteSavedView(id: string): Promise<void> {
  const supabase = await createClient();
  const ownerId = await requireCallerId(supabase);

  const { error } = await supabase.schema("ops").from("saved_filter_views").delete().eq("id", id).eq("owner_id", ownerId);
  if (error) throw new Error(error.message);
  revalidatePath("/movement");
}
