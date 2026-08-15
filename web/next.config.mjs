/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Server Components hit Supabase on every request for RLS-correct data —
    // see docs/api-layer-plan.md §7. Nothing here should be statically cached
    // by default.
    //
    // staleTimes.dynamic: Next 14's CLIENT-side Router Cache still caches a
    // dynamic route's RSC payload per-URL for 30s by default, separately
    // from (and not fixed by) `export const dynamic = "force-dynamic"` on
    // the page itself — that only stops the SERVER from statically caching
    // the response. Confirmed live on /targets: saving a target, or
    // navigating store A -> B -> back to A within 30s, re-served the
    // pre-save/pre-navigation cached payload from the browser even though
    // the database and every server-side query were already correct. 0
    // forces every soft navigation on a dynamic route to refetch, matching
    // what "force-dynamic" already implies everywhere else in this app.
    staleTimes: {
      dynamic: 0,
    },
  },
};

export default nextConfig;
