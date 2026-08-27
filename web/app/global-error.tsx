"use client";

/**
 * Last-resort boundary for failures in the ROOT layout itself (D-06) — the
 * one case app/error.tsx cannot catch, because it renders inside that layout.
 *
 * Next.js replaces the entire root layout with this component when it fires,
 * so it must render its own <html> and <body>; there is no shell around it.
 * For the same reason it cannot rely on the theme script in app/layout.tsx or
 * on any provider, so colors here are literal rather than design tokens — a
 * token would resolve against a stylesheet that may itself be what failed.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          background: "#ffffff",
          color: "#1a1a1a",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        <div style={{ maxWidth: 560, margin: "80px auto", padding: "0 24px" }}>
          <div style={{ borderLeft: "2px solid #b42318", background: "#fef3f2", padding: "12px 16px" }}>
            <p style={{ margin: 0, fontWeight: 600, color: "#b42318", fontSize: 14 }}>
              The application failed to load.
            </p>
            <p style={{ margin: "4px 0 0", fontSize: 14, color: "#555555" }}>
              This is a problem with the app shell itself, not with one report. Try again, or
              reload the page.
            </p>
            {error.digest ? (
              <p
                style={{
                  margin: "4px 0 0",
                  fontSize: 11,
                  fontFamily: "ui-monospace, monospace",
                  color: "#555555",
                }}
              >
                Reference: {error.digest}
              </p>
            ) : null}
            <button
              type="button"
              onClick={reset}
              style={{
                marginTop: 8,
                border: "1px solid #d0d5dd",
                background: "transparent",
                padding: "4px 12px",
                fontSize: 12,
                color: "#1a1a1a",
                cursor: "pointer",
              }}
            >
              Try again
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
