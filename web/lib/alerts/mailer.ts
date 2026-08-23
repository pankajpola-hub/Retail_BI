import "server-only";
import nodemailer from "nodemailer";
import type { StoreException } from "@/lib/sales/exceptions";

/**
 * Threshold alerts' email transport — same Gmail SMTP account already used
 * by the Shopify image-uploader project's report emails
 * (D:\Py\Shopify image uploader\server\main.py's send_report_email:
 * smtp.gmail.com:587, STARTTLS, app-password auth via Python's smtplib).
 * nodemailer's createTransport with secure:false + requireTLS:true on port
 * 587 is the direct equivalent of that script's
 * `server.starttls(); server.login(user, password)`.
 *
 * SMTP_HOST/PORT/USER/PASSWORD reuse the exact same env var names as that
 * project's server/.env, so the same values can be copied across without
 * renaming anything.
 */
function getTransport() {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;
  if (!host || !port || !user || !pass) {
    throw new Error("SMTP not configured — SMTP_HOST/PORT/USER/PASSWORD must all be set.");
  }
  return nodemailer.createTransport({
    host,
    port: Number(port),
    secure: false,
    requireTLS: true,
    auth: { user, pass },
  });
}

const INR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

function buildDigestBody(exceptions: StoreException[]): { text: string; html: string } {
  const lines = exceptions.map(
    (e) => `${e.name}: ${e.netChangePct >= 0 ? "+" : ""}${e.netChangePct.toFixed(1)}% (${INR(e.net)})`
  );
  const text = `Needs attention — EBO sales\n\n${lines.join("\n")}\n\nSee the full Overview: https://pep-retail-bi.vercel.app/network`;

  const rows = exceptions
    .map(
      (e) =>
        `<tr><td style="padding:6px 10px;border-bottom:1px solid #e6e6e8;">${e.name}</td>` +
        `<td style="padding:6px 10px;border-bottom:1px solid #e6e6e8;color:${e.netChangePct < -20 ? "#a02c22" : "#8a6d1f"};font-weight:600;">${e.netChangePct >= 0 ? "+" : ""}${e.netChangePct.toFixed(1)}%</td>` +
        `<td style="padding:6px 10px;border-bottom:1px solid #e6e6e8;text-align:right;font-family:monospace;">${INR(e.net)}</td></tr>`
    )
    .join("");
  const html =
    `<div style="font-family:sans-serif;color:#111113;">` +
    `<h2 style="font-size:16px;">Needs attention — EBO sales</h2>` +
    `<table style="border-collapse:collapse;width:100%;max-width:480px;">` +
    `<thead><tr><th style="text-align:left;padding:6px 10px;">Store</th><th style="text-align:left;padding:6px 10px;">WoW</th><th style="text-align:right;padding:6px 10px;">Latest week</th></tr></thead>` +
    `<tbody>${rows}</tbody></table>` +
    `<p style="margin-top:16px;"><a href="https://pep-retail-bi.vercel.app/network">See the full Overview</a></p></div>`;

  return { text, html };
}

/**
 * Sends one digest email. Callers should only call this with a non-empty
 * `exceptions` array — runDueAlerts skips sending (but still marks the
 * subscription as checked) when there's nothing to report.
 */
export async function sendAlertDigest(
  to: string | string[],
  exceptions: StoreException[],
  options: { subjectPrefix?: string } = {}
): Promise<void> {
  const { text, html } = buildDigestBody(exceptions);
  const from = process.env.ALERT_EMAIL_FROM || process.env.SMTP_USER;
  const transport = getTransport();

  // De-duplicate: the admin-configured extra recipients (Configurations →
  // Alert digest) are appended to every send, so a subscriber who is ALSO on
  // that list would otherwise receive the same digest twice. Case-insensitive,
  // because SMTP local parts are technically case-sensitive but no real
  // provider treats them that way.
  const recipients = [...new Set((Array.isArray(to) ? to : [to]).map((r) => r.trim()).filter(Boolean).map((r) => r.toLowerCase()))];
  if (recipients.length === 0) throw new Error("No recipients to send to.");

  const prefix = options.subjectPrefix ? `${options.subjectPrefix} ` : "";
  await transport.sendMail({
    from,
    to: recipients,
    subject: `${prefix}Retail BI — ${exceptions.length} store${exceptions.length === 1 ? "" : "s"} need attention`,
    text,
    html,
  });
}
