import { cookies } from "next/headers";
import { DICTIONARIES, isLang, type Dict, type Lang } from "./translations";

export const LANG_COOKIE = "lang";

/**
 * Server-side language resolution. Reads the cookie the LanguageSwitcher
 * sets; falls back to English for anything unrecognised (including a
 * tampered cookie value), so a bad cookie degrades to the default rather
 * than crashing the render.
 *
 * Client Components can't call this — pass the dict down as a prop from the
 * server page that renders them (see app/(ebo)/footfall/page.tsx).
 */
export async function getLang(): Promise<Lang> {
  const store = await cookies();
  const value = store.get(LANG_COOKIE)?.value;
  return isLang(value) ? value : "en";
}

export async function getDict(): Promise<Dict> {
  return DICTIONARIES[await getLang()];
}
