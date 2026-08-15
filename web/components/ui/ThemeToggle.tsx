"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");

  // Read what the no-flash script in app/layout.tsx already applied, so the
  // button label matches the rendered theme on first paint.
  useEffect(() => {
    const current = (document.documentElement.getAttribute("data-theme") as Theme) ?? "light";
    setTheme(current);
  }, []);

  function toggle() {
    const next: Theme = theme === "light" ? "dark" : "light";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("theme", next);
    } catch {
      // Private browsing / storage disabled — the theme still applies for
      // this page view, it just won't persist. Not worth surfacing.
    }
  }

  return (
    <button
      onClick={toggle}
      // A bare glyph with no box is a ~7px hit target — impossible to tap
      // reliably. min-w/h + centering gives a real 40px touch target without
      // changing how big the icon looks.
      className="flex min-h-[40px] min-w-[40px] items-center justify-center text-[15px] text-ink-3 hover:text-ink"
      aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
      title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
    >
      {theme === "light" ? "☾" : "☀"}
    </button>
  );
}
