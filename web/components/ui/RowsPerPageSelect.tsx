"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";

const OPTIONS = ["10", "50", "100", "max"];

// Rows-per-page needs a client component (not a plain <select> in a GET
// form) because changing it must also reset `page` back to 1 — otherwise
// picking a smaller page size while sitting on page 4 could land past the
// end of the now-shorter result set. Page-number links themselves stay
// plain server-rendered <a> tags (see page.tsx's buildPageHref) since they
// don't need this reset behavior.
export function RowsPerPageSelect({ selected }: { selected: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function onChange(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("perPage", value);
    params.delete("page");
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <label className="flex items-center gap-2 text-[12px] text-ink-3">
      Rows per page
      <select
        value={selected}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-[30px] border border-line bg-surface px-2 py-1 text-[12.5px] text-ink-2"
        aria-label="Rows per page"
      >
        {OPTIONS.map((o) => (
          <option key={o} value={o}>
            {o === "max" ? "Max" : o}
          </option>
        ))}
      </select>
    </label>
  );
}
