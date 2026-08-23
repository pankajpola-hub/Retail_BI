"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PAGE_LABELS, type PageKey } from "@/lib/auth/permissions";

/**
 * Explains an access denial instead of silently bouncing the user.
 *
 * requirePageAccess() used to `redirect(resolveHome(...))` with no signal at
 * all: someone who lost access to a bookmarked page just landed on Network
 * with no idea why, and no idea who to ask. A bare redirect is a worse
 * pattern than a 403 — at least a 403 tells you something happened. As of
 * 0079 it appends ?denied=<pageKey>&why=<reason>, which this reads.
 *
 * Deliberately dismissible and URL-driven rather than a toast: it survives
 * the reload, and clearing it strips the params so a later refresh doesn't
 * resurrect a stale message.
 */
function DeniedNoticeInner() {
  const params = useSearchParams();
  const router = useRouter();

  const denied = params.get("denied");
  if (!denied) return null;

  const why = params.get("why");
  const label = PAGE_LABELS[denied as PageKey] ?? denied;

  const explanation =
    why === "business_unit"
      ? `${label} belongs to a business unit you don't have access to.`
      : `You don't have access to ${label}.`;

  function dismiss() {
    const next = new URLSearchParams(params.toString());
    next.delete("denied");
    next.delete("why");
    const qs = next.toString();
    router.replace(qs ? `?${qs}` : window.location.pathname);
  }

  return (
    <div className="mt-3 flex items-start gap-3 border-l-2 border-warn bg-warn-soft px-3 py-2 text-sm text-ink-2">
      <span className="mt-0.5 shrink-0 text-warn" aria-hidden>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v6M12 16.5v.5" />
        </svg>
      </span>
      <span className="flex-1">
        {explanation} You were sent here instead. Ask a super admin if you think you should have it.
      </span>
      <button
        type="button"
        onClick={dismiss}
        className="shrink-0 text-[11px] text-ink-3 underline hover:text-ink"
      >
        Dismiss
      </button>
    </div>
  );
}

export function DeniedNotice() {
  // useSearchParams() needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <DeniedNoticeInner />
    </Suspense>
  );
}
