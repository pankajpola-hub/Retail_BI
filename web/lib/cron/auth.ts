import "server-only";
import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";

/**
 * Shared CRON_SECRET bearer check for every route under app/api/cron/*.
 *
 * Replaces the five hand-rolled copies of
 *
 *     if (auth !== `Bearer ${process.env.CRON_SECRET}`) { ...401... }
 *
 * which had two problems (audit B-07):
 *
 * 1. NOT FAIL-CLOSED. With CRON_SECRET unset in an environment (a new
 *    preview deployment, a renamed variable, a missed Vercel env entry) the
 *    template literal collapses to the literal string "Bearer undefined" —
 *    which any caller can simply send, unlocking five service-role routes
 *    that write to raw_logic/raw_uniware and send email. Here a missing
 *    secret is a 500 (a misconfigured server, not an authorized caller),
 *    never an open door.
 * 2. Non-constant-time comparison. Theoretical for a high-entropy secret
 *    over HTTPS, but free to fix alongside the guard.
 *
 * On the length-mismatch trap: crypto.timingSafeEqual THROWS when the two
 * buffers differ in length, so it cannot be fed the raw header directly
 * (an attacker controls that length). Both sides are hashed to a fixed
 * 32-byte SHA-256 digest first, so the compared buffers are always the same
 * length and the comparison itself stays constant-time. Digest equality
 * implies string equality for any realistic input.
 *
 * Returns a NextResponse to return immediately, or null when the caller is
 * authorized:
 *
 *     const denied = cronAuthFailure(request);
 *     if (denied) return denied;
 */
export function cronAuthFailure(request: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // Deliberately generic to the caller; the detail goes to the server log.
    console.error("[cron/auth] CRON_SECRET is not set — refusing the request (fail-closed).");
    return NextResponse.json(
      { ok: false, error: { code: "cron_not_configured", message: "Cron authentication is not configured." } },
      { status: 500 }
    );
  }

  const provided = request.headers.get("authorization") ?? "";
  if (!constantTimeEquals(provided, `Bearer ${secret}`)) {
    return NextResponse.json({ ok: false, error: { code: "unauthorized", message: "Not authorized." } }, { status: 401 });
  }

  return null;
}

function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}
