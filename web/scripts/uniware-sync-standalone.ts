#!/usr/bin/env -S node --conditions=react-server --import tsx
/**
 * Standalone Uniware sync — runs the SAME job as
 * api/cron/uniware-sync/route.ts (lib/uniware/syncJob.ts), but invoked from
 * a GitHub Actions schedule instead of Vercel Cron.
 *
 * WHY THIS EXISTS (2026-09-03): Vercel's Hobby plan caps cron invocations at
 * once per DAY, platform-wide — no schedule string in vercel.json can change
 * that. At ~500 new Uniware orders/day and only one sync run/day, the
 * item-enrichment queue could never catch up (see this repo's
 * docs/audit/PROGRESS.md, 2026-09-03 entry, and route.ts's own history for
 * the full investigation — the user's own Uniware dashboard showed ~4x the
 * revenue this app was reporting for the same day). GitHub Actions has no
 * per-day cap and no 60-second function-duration ceiling, so this can run
 * every few minutes with a much larger batch — same database, same
 * idempotent upsert-by-natural-key RPCs either way.
 *
 * HOW `import "server-only"` IS HANDLED: lib/uniware/syncJob.ts and its
 * dependencies (lib/uniware/client.ts, lib/data/admin.ts) all start with
 * `import "server-only"`, a marker package that unconditionally throws
 * under Node's default module resolution — it only resolves to a no-op
 * under the "react-server" package.json export condition, which is what
 * Next.js's own RSC bundler sets when compiling Server Components. This
 * script is invoked with `node --conditions=react-server` (see the shebang
 * above, and the same flag in .github/workflows/uniware-sync.yml) to set
 * that SAME condition outside Next.js — not bypassing what the guard
 * protects against (accidentally shipping server-only code to a browser
 * bundle), which has no meaning in a plain Node script that never touches a
 * browser bundle in the first place.
 *
 * WHY IMPORT THE REAL LIB FILES rather than reimplement: lib/uniware/
 * client.ts's SOAP request-building (WS-Security headers, exact endpoint
 * shape) was verified against the live tenant with real trial and error —
 * its own header describes an early attempt that "failed silently on a
 * wrong Password Type URI." Reimplementing that logic here would risk
 * silently drifting from the working version; importing it keeps there
 * being exactly one copy.
 *
 * Run locally: from web/, `npm run sync:uniware`
 * (equivalent to: node --conditions=react-server --import tsx ./scripts/uniware-sync-standalone.ts)
 *
 * Required environment variables (GitHub Actions: repo Settings -> Secrets
 * and variables -> Actions -> New repository secret, one per line below):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   UNIWARE_BASE_URL
 *   UNIWARE_SEARCH_API_USERNAME
 *   UNIWARE_SEARCH_API_KEY
 *   UNIWARE_GETORDER_API_USERNAME
 *   UNIWARE_GETORDER_API_KEY
 *   UNIWARE_REST_USERNAME       (optional — returns sync skips quietly without it)
 *   UNIWARE_REST_PASSWORD       (optional, paired with the above)
 *   UNIWARE_FACILITY_CODE       (optional)
 */
import { createAdminClient } from "../lib/data/admin";
import { runUniwareSync } from "../lib/uniware/syncJob";

const REQUIRED_ENV = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "UNIWARE_BASE_URL",
  "UNIWARE_SEARCH_API_USERNAME",
  "UNIWARE_SEARCH_API_KEY",
  "UNIWARE_GETORDER_API_USERNAME",
  "UNIWARE_GETORDER_API_KEY",
] as const;

async function main() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`Missing required environment variable(s): ${missing.join(", ")}`);
    process.exit(1);
  }

  // GitHub Actions runners have no per-run duration pressure the way Vercel
  // does — a larger batch and higher concurrency than the Vercel route uses
  // is safe here. Still bounded (not unlimited): the upstream Uniware
  // tenant is a real shared system that could rate-limit or throttle a
  // burst from one IP regardless of which platform is calling it.
  const admin = await createAdminClient();
  const result = await runUniwareSync(admin, {
    itemEnrichmentBatchSize: 200,
    itemEnrichmentConcurrency: 8,
    returnsDetailBatchSize: 100,
  });

  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(`Sync completed with ${result.errors.length} error(s) — see above.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Uniware sync crashed:", err);
  process.exit(1);
});
