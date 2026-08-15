"use client";

import { useRouter } from "next/navigation";
import { LANGUAGES, LANGUAGE_NAMES, type Lang } from "@/lib/i18n/translations";

export function LanguageSwitcher({ current }: { current: Lang }) {
  const router = useRouter();

  function change(next: string) {
    // 1 year, site-wide. Not httpOnly on purpose — this is a display
    // preference with no security meaning, and keeping it readable lets the
    // client set it without a round-trip to an API route.
    document.cookie = `lang=${next}; path=/; max-age=31536000; samesite=lax`;
    // Server Components render the translated strings, so the page has to
    // be re-fetched for the change to show.
    router.refresh();
  }

  return (
    <select
      defaultValue={current}
      onChange={(e) => change(e.target.value)}
      className="min-h-[36px] border border-line bg-surface px-2 py-1.5 text-[12px] text-ink-2"
      aria-label="Language"
    >
      {LANGUAGES.map((l) => (
        <option key={l} value={l}>
          {LANGUAGE_NAMES[l]}
        </option>
      ))}
    </select>
  );
}
