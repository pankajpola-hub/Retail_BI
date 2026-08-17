"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createWorkspace, renameWorkspace, forkWorkspace } from "@/lib/workspace/actions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

type MyWorkspace = { id: string; name: string; isDefault: boolean };
type SharedWorkspace = { id: string; name: string; ownerId: string };

/**
 * 2026-08-15 — closes the gap identified when investigating "where can a
 * saved workspace be reopened": per-user saving already worked (owner-
 * scoped RLS), but there was NO UI to see a list of your own workspaces,
 * create a second one, or browse what's shared with you — Phase 7's
 * listSharedWithMe/forkWorkspace existed only in lib/workspace/actions.ts
 * with zero callers anywhere in web/app. This is that missing surface.
 *
 * Switching navigates to ?workspaceId=<id> (router.push only, no paired
 * router.refresh() — see HANDOFF.md's documented reason: a new URL is
 * already a client Router Cache miss, refresh() is a redundant fetch).
 */
export function WorkspaceSwitcher({
  current,
  myWorkspaces,
  sharedWithMe,
}: {
  current: { id: string; name: string; isDefault: boolean };
  myWorkspaces: MyWorkspace[];
  sharedWithMe: SharedWorkspace[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(current.name);
  const [isPending, startTransition] = useTransition();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  function goTo(id: string) {
    setOpen(false);
    router.push(`/workspace?workspaceId=${id}`);
  }

  function handleCreate() {
    startTransition(async () => {
      const name = prompt("New workspace name", "New workspace")?.trim();
      if (!name) return;
      const id = await createWorkspace(name);
      router.push(`/workspace?workspaceId=${id}`);
    });
  }

  function handleFork(sourceId: string, sourceName: string) {
    startTransition(async () => {
      const id = await forkWorkspace(sourceId, `${sourceName} (copy)`);
      router.push(`/workspace?workspaceId=${id}`);
    });
  }

  function handleRenameSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = nameDraft.trim();
    setRenaming(false);
    if (!trimmed || trimmed === current.name) return;
    startTransition(async () => {
      await renameWorkspace(current.id, trimmed);
      router.refresh();
    });
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-2.5">
        {renaming ? (
          <form onSubmit={handleRenameSubmit} className="flex items-center gap-1.5">
            <input
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={handleRenameSubmit}
              className="min-h-[30px] border border-line bg-surface px-2 text-xl font-serif"
            />
          </form>
        ) : (
          <button
            type="button"
            onClick={() => {
              setNameDraft(current.name);
              setRenaming(true);
            }}
            className="font-serif text-2xl hover:underline"
            title="Click to rename"
          >
            {current.name}
          </button>
        )}
        {current.isDefault && (
          <Badge variant="secondary" className="normal-case">
            Default
          </Badge>
        )}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={isPending}
          aria-haspopup="true"
          aria-expanded={open}
          className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-ink"
          aria-label="Switch or manage workspaces"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </div>

      {open && (
        <div className="absolute left-0 top-full z-20 mt-2 w-[300px] rounded-lg border border-line bg-surface p-2 shadow-xl">
          <div className="px-2 pb-1 pt-1 text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
            My workspaces
          </div>
          <div className="flex flex-col">
            {myWorkspaces.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => goTo(w.id)}
                className={`flex items-center justify-between rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-surface-2 ${
                  w.id === current.id ? "bg-accent-soft text-accent-ink" : "text-ink-2"
                }`}
              >
                <span className="truncate">{w.name}</span>
                {w.isDefault && <span className="text-[10px] text-ink-3">Default</span>}
              </button>
            ))}
          </div>

          {sharedWithMe.length > 0 && (
            <>
              <div className="mt-2 border-t border-line-soft px-2 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
                Shared with me
              </div>
              <div className="flex flex-col">
                {sharedWithMe.map((w) => (
                  <div key={w.id} className="flex items-center justify-between rounded-md px-2 py-1.5 text-[13px] text-ink-2">
                    <span className="truncate">{w.name}</span>
                    <button
                      type="button"
                      onClick={() => handleFork(w.id, w.name)}
                      disabled={isPending}
                      className="shrink-0 text-[11px] font-semibold text-accent hover:underline"
                    >
                      Personalize a copy
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="mt-2 border-t border-line-soft pt-2">
            <Button size="sm" variant="outline" onClick={handleCreate} disabled={isPending} className="w-full">
              + New workspace
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
