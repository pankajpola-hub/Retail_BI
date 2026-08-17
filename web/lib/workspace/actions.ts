"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/data/client";
import type { DataClient } from "@/lib/data/client";

/**
 * Phase 5 workspace CRUD. Deliberately thin: every table here is protected
 * by owner-only RLS (migration 0049 — workspace_owner_all and the two
 * indirect "join back to workspaces" policies), so these actions don't
 * re-implement authorization, they just call the same RLS-scoped client
 * every page uses (lib/data/client.ts createClient(), NOT the admin
 * client — there is no reason for a workspace action to bypass RLS).
 *
 * Same "re-check the caller independently of whatever layout ran" posture
 * as app/(admin)/users/actions.ts and app/(ho)/targets — Server Actions are
 * directly callable regardless of which page rendered the form that
 * triggered them. Unlike requirePageAccess()/requireRole() (which redirect,
 * the right behavior for a page render), a Server Action throws on missing
 * auth — a redirect response doesn't make sense for a fetch-shaped call.
 */

type WorkspaceRow = { id: string; name: string; owner_id: string; type: string; is_default: boolean; version: number };
type ComponentRow = {
  id: string;
  workspace_id: string;
  component_id: string;
  grid_x: number;
  grid_y: number;
  grid_w: number;
  grid_h: number;
  config: Record<string, unknown>;
  sort_order: number;
};
type FilterRow = { id: string; workspace_id: string; dimension_id: string; operator: string; values: string[] };

async function requireCallerId(supabase: DataClient): Promise<string> {
  const {
    data: { user: caller },
  } = await supabase.auth.getUser();
  if (!caller) throw new Error("Not authenticated.");
  return caller.id;
}

export type WorkspaceSnapshot = {
  workspace: WorkspaceRow;
  components: ComponentRow[];
  filters: FilterRow[];
};

/**
 * Returns the caller's default workspace, creating one (empty, no
 * components) on first visit. is_default has a partial unique index per
 * owner (migration 0049), so this can never end up with two defaults for
 * the same user even under a race.
 */
async function loadWorkspaceSnapshot(supabase: DataClient, workspace: WorkspaceRow): Promise<WorkspaceSnapshot> {
  const [{ data: components }, { data: filters }] = await Promise.all([
    supabase
      .schema("workspace")
      .from<ComponentRow>("workspace_components")
      .select("id, workspace_id, component_id, grid_x, grid_y, grid_w, grid_h, config, sort_order")
      .eq("workspace_id", workspace.id)
      .order("sort_order"),
    supabase
      .schema("workspace")
      .from<FilterRow>("workspace_filters")
      .select("id, workspace_id, dimension_id, operator, values")
      .eq("workspace_id", workspace.id),
  ]);

  return { workspace, components: components ?? [], filters: filters ?? [] };
}

export async function getOrCreateDefaultWorkspace(): Promise<WorkspaceSnapshot> {
  const supabase = await createClient();
  const ownerId = await requireCallerId(supabase);

  const { data: existing } = await supabase
    .schema("workspace")
    .from<WorkspaceRow>("workspaces")
    .select("id, name, owner_id, type, is_default, version")
    .eq("owner_id", ownerId)
    .eq("is_default", true)
    .maybeSingle();

  let workspace = existing;
  if (!workspace) {
    const { data: created, error } = await supabase
      .schema("workspace")
      .from<WorkspaceRow>("workspaces")
      .insert({ name: "My Workspace", owner_id: ownerId, type: "personal", is_default: true })
      .select("id, name, owner_id, type, is_default, version")
      .single();
    if (error || !created) throw new Error(error?.message ?? "Failed to create default workspace.");
    workspace = created;
  }

  return loadWorkspaceSnapshot(supabase, workspace);
}

/**
 * Loads a SPECIFIC workspace by id (2026-08-15 — the workspace list/switcher
 * feature: `workspace.workspaces` already supports multiple non-default
 * workspaces per owner, migration 0049's own comment says so, this was
 * purely a missing UI/action gap). RLS decides readability, same posture as
 * forkWorkspace's source read — an id the caller can't read (not theirs,
 * not shared with them) simply returns null rather than throwing, so the
 * caller can fall back to the default workspace instead of erroring the
 * whole page.
 */
export async function getWorkspaceById(id: string): Promise<WorkspaceSnapshot | null> {
  const supabase = await createClient();
  await requireCallerId(supabase);

  const { data: workspace } = await supabase
    .schema("workspace")
    .from<WorkspaceRow>("workspaces")
    .select("id, name, owner_id, type, is_default, version")
    .eq("id", id)
    .maybeSingle();
  if (!workspace) return null;

  return loadWorkspaceSnapshot(supabase, workspace);
}

/** Every workspace the caller owns — "My workspaces" list in WorkspaceSwitcher.tsx. */
export async function listMyWorkspaces(): Promise<{ id: string; name: string; isDefault: boolean }[]> {
  const supabase = await createClient();
  const ownerId = await requireCallerId(supabase);

  const { data, error } = await supabase
    .schema("workspace")
    .from<{ id: string; name: string; is_default: boolean }>("workspaces")
    .select("id, name, is_default")
    .eq("owner_id", ownerId)
    .order("is_default", { ascending: false })
    .order("name");
  if (error) throw new Error(error.message);

  return (data ?? []).map((w) => ({ id: w.id, name: w.name, isDefault: w.is_default }));
}

/**
 * A SECOND workspace-creation path alongside getOrCreateDefaultWorkspace's
 * implicit one — that one only ever creates the single is_default=true row
 * per owner (enforced by 0049's partial unique index); this creates an
 * additional named, non-default workspace, empty (no components/filters),
 * for the "+ New workspace" action in WorkspaceSwitcher.tsx.
 */
export async function createWorkspace(name: string): Promise<string> {
  const supabase = await createClient();
  const ownerId = await requireCallerId(supabase);

  const trimmed = name.trim();
  if (!trimmed) throw new Error("Workspace name can't be empty.");

  const { data, error } = await supabase
    .schema("workspace")
    .from<{ id: string }>("workspaces")
    .insert({ name: trimmed, owner_id: ownerId, type: "personal", is_default: false })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Failed to create workspace.");
  return data.id;
}

/** RLS (workspaces_owner_all) already restricts this to the owner — no app-side ownership re-check needed beyond requireCallerId. */
export async function renameWorkspace(id: string, name: string): Promise<void> {
  const supabase = await createClient();
  await requireCallerId(supabase);

  const trimmed = name.trim();
  if (!trimmed) throw new Error("Workspace name can't be empty.");

  const { error } = await supabase.schema("workspace").from("workspaces").update({ name: trimmed }).eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/workspace");
}

export async function addComponent(
  workspaceId: string,
  componentId: string,
  position: { x: number; y: number; w: number; h: number }
): Promise<void> {
  const supabase = await createClient();
  await requireCallerId(supabase);

  const { data: existing } = await supabase
    .schema("workspace")
    .from<{ sort_order: number }>("workspace_components")
    .select("sort_order")
    .eq("workspace_id", workspaceId)
    .order("sort_order", { ascending: false })
    .limit(1);
  const nextSortOrder = (existing?.[0]?.sort_order ?? -1) + 1;

  const { error } = await supabase
    .schema("workspace")
    .from("workspace_components")
    .insert({
      workspace_id: workspaceId,
      component_id: componentId,
      grid_x: position.x,
      grid_y: position.y,
      grid_w: position.w,
      grid_h: position.h,
      sort_order: nextSortOrder,
    });
  if (error) throw new Error(error.message);
  revalidatePath("/workspace");
}

export async function removeComponent(componentInstanceId: string): Promise<void> {
  const supabase = await createClient();
  await requireCallerId(supabase);

  const { error } = await supabase
    .schema("workspace")
    .from("workspace_components")
    .delete()
    .eq("id", componentInstanceId);
  if (error) throw new Error(error.message);
  revalidatePath("/workspace");
}

/**
 * Batch position update after a drag/resize. Not a single bulk statement —
 * the app's PostgREST query builder (lib/postgrest/client.ts) has no
 * bulk-upsert-with-per-row-values primitive, and this is a low-frequency,
 * small-N write (one save per drag session, a handful of components), not a
 * hot path worth hand-rolling raw SQL for.
 */
export async function updateComponentLayout(
  updates: { id: string; x: number; y: number; w: number; h: number }[]
): Promise<void> {
  const supabase = await createClient();
  await requireCallerId(supabase);

  for (const u of updates) {
    const { error } = await supabase
      .schema("workspace")
      .from("workspace_components")
      .update({ grid_x: u.x, grid_y: u.y, grid_w: u.w, grid_h: u.h })
      .eq("id", u.id);
    if (error) throw new Error(error.message);
  }
  revalidatePath("/workspace");
}

/** Removes every component from a workspace, keeping the workspace row and its filters — "start over" without losing the workspace identity/default flag. */
export async function resetWorkspace(workspaceId: string): Promise<void> {
  const supabase = await createClient();
  await requireCallerId(supabase);

  const { error } = await supabase
    .schema("workspace")
    .from("workspace_components")
    .delete()
    .eq("workspace_id", workspaceId);
  if (error) throw new Error(error.message);
  revalidatePath("/workspace");
}

/**
 * Upserts the workspace-level store/date scope every wired-up component
 * inherits. Delete-then-insert per dimension, same tradeoff as
 * updateUserStoreAccess in app/(admin)/users/actions.ts — simpler than a
 * diff, acceptable for a low-frequency admin-ish write.
 */
export async function updateWorkspaceFilters(
  workspaceId: string,
  filters: { storeIds: string[]; from: string; to: string }
): Promise<void> {
  const supabase = await createClient();
  await requireCallerId(supabase);

  const { error: deleteError } = await supabase
    .schema("workspace")
    .from("workspace_filters")
    .delete()
    .eq("workspace_id", workspaceId)
    .in("dimension_id", ["store", "date"]);
  if (deleteError) throw new Error(deleteError.message);

  const rows: Record<string, unknown>[] = [
    { workspace_id: workspaceId, dimension_id: "date", operator: "range", values: [filters.from, filters.to] },
  ];
  if (filters.storeIds.length > 0) {
    rows.push({ workspace_id: workspaceId, dimension_id: "store", operator: "in", values: filters.storeIds });
  }

  const { error: insertError } = await supabase.schema("workspace").from("workspace_filters").insert(rows);
  if (insertError) throw new Error(insertError.message);
  revalidatePath("/workspace");
}

/* ---------------------------------------------------------------------------
 * Phase 7 — sharing (migration 0052) and its security fix (0053).
 *
 * Sharing conveys LAYOUT only, never data access: a workspace row stores which
 * components sit where plus a filter scope, and every component still resolves
 * its numbers through views scoped by the VIEWER's core.fn_user_store_ids().
 * Two people opening one shared workspace legitimately see different figures,
 * and that difference is the security model, not a bug — migration 0052's
 * header is the long version.
 *
 * These actions stay as thin as the Phase 5 ones above for the same reason:
 * authorization lives in the database. 0053 added a BEFORE INSERT/UPDATE
 * trigger (workspace.fn_validate_permission_grant) that verifies the caller is
 * the workspace's real owner and OVERWRITES owner_id/granted_by with
 * server-derived values, after a client-supplied owner_id was found to forge
 * the entire authorization decision. Re-checking ownership in TypeScript here
 * would be a second copy of that rule, free to drift from the one that is
 * actually enforced, while adding no security — so we don't.
 * ------------------------------------------------------------------------- */

/**
 * Grants a user 'view' on a workspace. Only the workspace's owner can succeed:
 * the 0053 trigger raises `insufficient_privilege` for anyone else, which
 * surfaces here as a thrown Error rather than being swallowed — a caller who
 * isn't the owner should see a failure, not a silent no-op that looks shared.
 *
 * owner_id/granted_by are sent as the caller's own id purely to satisfy the
 * NOT NULL columns; the trigger overwrites both and is the real authority on
 * their values, so nothing here depends on the client getting them right.
 *
 * Upserted on the unique (workspace_id, principal_type, principal_id) so
 * re-sharing with someone who already has access refreshes the grant instead
 * of erroring on a duplicate — "share" is idempotent from the user's side.
 */
export async function shareWorkspace(workspaceId: string, principalUserId: string): Promise<void> {
  const supabase = await createClient();
  const callerId = await requireCallerId(supabase);

  const { error } = await supabase
    .schema("workspace")
    .from("workspace_permissions")
    .upsert(
      {
        workspace_id: workspaceId,
        principal_type: "user",
        principal_id: principalUserId,
        capability: "view",
        owner_id: callerId,
        granted_by: callerId,
      },
      { onConflict: "workspace_id,principal_type,principal_id" }
    );
  if (error) throw new Error(error.message);
  revalidatePath("/workspace");
}

/**
 * Removes a user's grant. RLS (workspace_permissions_owner_all) is what limits
 * this to the owner — a non-owner's delete matches zero rows rather than
 * erroring, which is the correct RLS semantics for a filtered DELETE.
 *
 * Revoking removes the live view only. Anyone who already forked the workspace
 * KEEPS their fork: a fork is an independent copy owned by them, not a window
 * onto the original, and it inherits no grants. That is intended and is
 * asserted in server/db/tests/rls_workspace_sharing.sql ("bob KEEPS his fork").
 */
export async function revokeWorkspaceShare(workspaceId: string, principalUserId: string): Promise<void> {
  const supabase = await createClient();
  await requireCallerId(supabase);

  const { error } = await supabase
    .schema("workspace")
    .from("workspace_permissions")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("principal_type", "user")
    .eq("principal_id", principalUserId);
  if (error) throw new Error(error.message);
  revalidatePath("/workspace");
}

/**
 * The grants on a workspace, for an owner-facing "shared with" list. No
 * caller filter is added: RLS already narrows this to rows the owner manages
 * plus the single row naming the caller as principal, so an app-side filter
 * would only duplicate the policy.
 */
export async function listWorkspaceShares(
  workspaceId: string
): Promise<{ principalId: string; capability: string; createdAt: string }[]> {
  const supabase = await createClient();
  await requireCallerId(supabase);

  const { data, error } = await supabase
    .schema("workspace")
    .from<{ principal_id: string; capability: string; created_at: string }>("workspace_permissions")
    .select("principal_id, capability, created_at")
    .eq("workspace_id", workspaceId)
    .eq("principal_type", "user")
    .order("created_at");
  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => ({
    principalId: row.principal_id,
    capability: row.capability,
    createdAt: row.created_at,
  }));
}

/**
 * Workspaces other people have shared with the caller. RLS already limits
 * visible rows to "owned by me" OR "granted to me" (0049's owner policy ORed
 * with 0053's workspaces_shared_select), so subtracting the caller's own rows
 * is exactly what isolates the granted set — no permissions join needed, and
 * no second source of truth about what counts as shared.
 */
export async function listSharedWithMe(): Promise<{ id: string; name: string; ownerId: string }[]> {
  const supabase = await createClient();
  const callerId = await requireCallerId(supabase);

  const { data, error } = await supabase
    .schema("workspace")
    .from<{ id: string; name: string; owner_id: string }>("workspaces")
    .select("id, name, owner_id")
    .neq("owner_id", callerId)
    .order("name");
  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => ({ id: row.id, name: row.name, ownerId: row.owner_id }));
}

/**
 * "Personalize a copy": deep-copies a readable workspace into a new one the
 * caller owns, and returns its id. Done as an RPC rather than a read-then-
 * write here because the copy must be atomic and because fn_fork_workspace is
 * SECURITY INVOKER — RLS decides what is copyable, so a source the caller
 * cannot read yields a Postgres exception instead of an empty copy. That error
 * is the not-readable signal, so it's rethrown rather than mapped to a null id.
 *
 * This is what keeps an official/shared workspace unchanged when someone
 * customizes it: they edit their fork, never the source (which grants them no
 * write access anyway).
 */
export async function forkWorkspace(sourceId: string, newName: string): Promise<string> {
  const supabase = await createClient();
  await requireCallerId(supabase);

  const { data, error } = await supabase
    .schema("workspace")
    .rpc<string>("fn_fork_workspace", { p_source_id: sourceId, p_new_name: newName });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Failed to fork workspace: source not found or not readable.");

  revalidatePath("/workspace");
  return data;
}
