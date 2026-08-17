/**
 * Dev-only query timing. Wrap a query/section with `time(label, promise)` and
 * its duration prints to the server console — nothing runs in production
 * (NODE_ENV check short-circuits to a plain passthrough) and nothing is sent
 * to the browser. This is Phase 1a instrumentation per the architecture
 * blueprint: no performance claim ships without a measured number attached.
 */
const ENABLED = process.env.NODE_ENV === "development";

export async function time<T>(label: string, work: PromiseLike<T>): Promise<T> {
  if (!ENABLED) return work;
  const start = performance.now();
  try {
    return await work;
  } finally {
    const ms = performance.now() - start;
    // eslint-disable-next-line no-console
    console.log(`[perf] ${label}: ${ms.toFixed(0)}ms`);
  }
}

/** Times a whole Promise.all group and also logs its own total. */
export async function timeAll<T extends readonly unknown[]>(
  label: string,
  work: readonly [...T]
): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
  if (!ENABLED) return Promise.all(work) as Promise<{ [K in keyof T]: Awaited<T[K]> }>;
  const start = performance.now();
  try {
    return (await Promise.all(work)) as { [K in keyof T]: Awaited<T[K]> };
  } finally {
    const ms = performance.now() - start;
    // eslint-disable-next-line no-console
    console.log(`[perf] ${label} (group): ${ms.toFixed(0)}ms`);
  }
}
