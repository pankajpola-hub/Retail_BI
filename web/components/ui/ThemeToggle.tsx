"use client";

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "./dropdown-menu";

type Theme = "light" | "dark" | "electro";

/**
 * A MENU, not a click-to-cycle button. This was a binary light/dark toggle
 * until the opt-in "electro" theme landed (globals.css
 * :root[data-theme="electro"]); cycling three states through one button would
 * mean every user reaching for dark mode lands on a black-and-neon terminal
 * skin by accident on the way past. An explicit pick is the correct UX for a
 * theme most people will never choose.
 *
 * The glyph column is fixed-width so the three labels line up, and the icons
 * are the same characters the old button used (☾/☀) plus ⚡ for electro —
 * text glyphs rather than lucide icons because the trigger has to keep
 * rendering at the old button's exact size and colour (AppShell force-
 * overrides `[&_button]` colour on the black top bar).
 */
const THEMES: { value: Theme; label: string; glyph: string }[] = [
  { value: "light", label: "Light", glyph: "☀" },
  { value: "dark", label: "Dark", glyph: "☾" },
  { value: "electro", label: "Electro", glyph: "⚡" },
];

function isTheme(v: string | null): v is Theme {
  return v === "light" || v === "dark" || v === "electro";
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");

  // Read what the no-flash script in app/layout.tsx already applied, so the
  // trigger glyph matches the rendered theme on first paint. Light is the
  // default and is represented by the ATTRIBUTE BEING ABSENT, so anything
  // unrecognised (including null) means light.
  useEffect(() => {
    const current = document.documentElement.getAttribute("data-theme");
    setTheme(isTheme(current) ? current : "light");
  }, []);

  function apply(next: Theme) {
    setTheme(next);
    // Light removes the attribute rather than setting data-theme="light":
    // :root alone already IS light, and keeping the DOM in the same shape the
    // no-flash script produces means the MutationObserver readers
    // (DataGrid.tsx, chartBase.tsx) see exactly one representation of light.
    if (next === "light") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("theme", next);
    } catch {
      // Private browsing / storage disabled — the theme still applies for
      // this page view, it just won't persist. Not worth surfacing.
    }
  }

  const active = THEMES.find((t) => t.value === theme) ?? THEMES[0]!;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        // Unchanged from the old single button: a bare glyph with no box is a
        // ~7px hit target — impossible to tap reliably. min-w/h + centering
        // gives a real 40px touch target without changing how big the icon
        // looks. AppShell's `[&_button]:!text-topbar-ink` override still
        // matches this element, so the black top bar keeps working.
        className="flex min-h-[40px] min-w-[40px] items-center justify-center text-[15px] text-ink-3 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
        aria-label={`Theme: ${active.label}. Change theme`}
        title={`Theme: ${active.label}`}
      >
        {active.glyph}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        {THEMES.map((t) => (
          <DropdownMenuItem key={t.value} onSelect={() => apply(t.value)}>
            <span className="w-3.5 shrink-0 text-center">{t.glyph}</span>
            <span className="flex-1">{t.label}</span>
            {/* The check is the state readout; aria-checked on a
                menuitemradio would be more semantic, but Radix's radio item
                owns its own value state and this menu's source of truth is
                the DOM attribute, so the label above carries it instead. */}
            {t.value === theme && <Check className="h-3 w-3 shrink-0 text-accent" aria-hidden />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
