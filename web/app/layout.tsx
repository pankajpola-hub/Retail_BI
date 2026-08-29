import type { Metadata } from "next";
import "./globals.css";
import { TopProgressBar } from "@/components/ui/TopProgressBar";

export const metadata: Metadata = {
  title: "EBO Sales Intelligence",
  description: "Detect, diagnose, recommend, act, measure — for the EBO network.",
};

// Applies the saved theme BEFORE first paint. Without this, a dark-mode user
// gets a white flash on every navigation while React hydrates. Deliberately
// inline and synchronous — that's the whole point; a deferred script would
// run too late to prevent the flash.
const NO_FLASH_THEME = `
(function () {
  try {
    var t = localStorage.getItem('theme');
    // Allow-list, not a passthrough: an arbitrary stored string would be
    // stamped straight onto <html> and could match nothing (silently light)
    // or a future unrelated attribute selector. 'light' is the default and
    // needs no attribute.
    if (t === 'dark' || t === 'electro') document.documentElement.setAttribute('data-theme', t);
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_THEME }} />
      </head>
      <body>
        <TopProgressBar />
        {children}
      </body>
    </html>
  );
}
