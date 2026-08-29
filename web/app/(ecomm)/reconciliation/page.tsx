import { requirePageAccess } from "@/lib/auth/roles";
import {
  getReconChannelSummary,
  getReconExceptionSummary,
  getReconLines,
} from "@/lib/recon/queries";
import ReconGrid from "@/components/recon/ReconGrid";

export const dynamic = "force-dynamic";

const inr = (v: number) => "₹" + Math.round(v).toLocaleString("en-IN");
const num = (v: number) => Math.round(v).toLocaleString("en-IN");

// Marketplace reconciliation lives under the ecomm vertical (Myntra, Ajio,
// Shopify, FirstCry, TataCliq are all ecomm channels). Access is gated the same
// way every ecomm page is: coarse role gate in (ecomm)/layout.tsx, fine
// business-unit check here via requirePageAccess("ecomm").
export default async function ReconciliationPage() {
  await requirePageAccess("ecomm");

  const [channels, exceptions, lines] = await Promise.all([
    getReconChannelSummary(),
    getReconExceptionSummary(),
    getReconLines(),
  ]);

  const tot = channels.reduce(
    (a, c) => ({
      lines: a.lines + Number(c.lines),
      orders: a.orders + Number(c.orders),
      net_sales: a.net_sales + Number(c.net_sales),
      discount: a.discount + Number(c.discount),
      tax: a.tax + Number(c.tax),
      exceptions: a.exceptions + Number(c.exceptions),
      exposure: a.exposure + Number(c.exposure),
    }),
    { lines: 0, orders: 0, net_sales: 0, discount: 0, tax: 0, exceptions: 0, exposure: 0 }
  );
  const cleanPct = tot.lines ? Math.round((100 * (tot.lines - tot.exceptions)) / tot.lines) : 0;

  const kpis = [
    { t: "Order Lines", v: num(tot.lines), d: `${num(tot.orders)} orders` },
    { t: "Net Sales", v: inr(tot.net_sales), d: `tax ${inr(tot.tax)}` },
    { t: "Discount", v: inr(tot.discount), d: "all channels" },
    { t: "Financially Clean", v: `${cleanPct}%`, d: `${num(tot.lines - tot.exceptions)} lines`, tone: "good" },
    { t: "Exceptions", v: num(tot.exceptions), d: "flagged lines", tone: "bad" },
    { t: "Flagged Exposure", v: inr(tot.exposure), d: "recover / verify", tone: "bad" },
  ];

  return (
    <div className="mx-auto max-w-[1240px] px-4 pb-24 pt-6 sm:px-6">
      <div className="mb-6 border-b border-border pb-4">
        <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-accent">
          Ecomm · Marketplace Reconciliation
        </div>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-ink">Reconciliation</h1>
        <p className="mt-1 text-[14px] text-ink-2">
          FY2026-27 · {channels.length} channels · {num(tot.lines)} order lines · line-level financial audit
        </p>
      </div>

      {/* KPI cards */}
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        {kpis.map((k) => (
          <div
            key={k.t}
            className={`relative overflow-hidden rounded-xl border border-border bg-surface p-4 shadow-sm ${
              k.tone === "bad" ? "before:bg-[var(--bad,#a8402f)]" : k.tone === "good" ? "before:bg-[var(--good,#2f7d5d)]" : "before:bg-accent"
            } before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:content-['']`}
          >
            <div className="font-mono text-[10px] uppercase tracking-wide text-ink-3">{k.t}</div>
            <div className={`mt-2 text-[24px] font-bold tabular-nums leading-none tracking-tight ${k.tone === "bad" ? "text-[var(--bad,#a8402f)]" : "text-ink"}`}>
              {k.v}
            </div>
            <div className="mt-1.5 text-[11.5px] text-ink-2">{k.d}</div>
          </div>
        ))}
      </div>

      {/* Exception ledger */}
      <h2 className="mb-1 mt-6 text-[17px] font-bold text-ink">Exception ledger</h2>
      <p className="mb-3 text-[12.5px] text-ink-3">Typed exceptions across all lines — severity and rupee exposure per type.</p>
      <div className="mb-5 overflow-x-auto rounded-xl border border-border bg-surface shadow-sm">
        <table className="w-full min-w-[560px] text-[13px]">
          <thead>
            <tr className="bg-surface-2 text-left font-mono text-[9.5px] uppercase tracking-wide text-ink-3">
              <th className="px-3.5 py-2.5">Exception</th>
              <th className="px-3.5 py-2.5">Severity</th>
              <th className="px-3.5 py-2.5 text-right">Lines</th>
              <th className="px-3.5 py-2.5 text-right">Exposure</th>
            </tr>
          </thead>
          <tbody>
            {exceptions.map((e) => (
              <tr key={e.exception_code} className="border-t border-border">
                <td className="px-3.5 py-2.5 font-mono text-[12.5px] text-ink">{e.exception_code}</td>
                <td className="px-3.5 py-2.5">
                  <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold ${
                    e.severity === "High" ? "bg-[var(--bad-soft,#f9e8e4)] text-[var(--bad,#a8402f)]" : "bg-[var(--warn-soft,#faf1de)] text-[var(--warn,#a06a1f)]"
                  }`}>{e.severity}</span>
                </td>
                <td className="px-3.5 py-2.5 text-right tabular-nums">{num(Number(e.n))}</td>
                <td className="px-3.5 py-2.5 text-right font-mono text-[var(--bad,#a8402f)]">
                  {Number(e.exposure) > 0 ? inr(Number(e.exposure)) : "—"}
                </td>
              </tr>
            ))}
            {exceptions.length === 0 && (
              <tr><td colSpan={4} className="px-3.5 py-4 text-center text-[var(--good,#2f7d5d)]">No exceptions — all clean.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Per-channel */}
      <h2 className="mb-1 mt-6 text-[17px] font-bold text-ink">Per-channel summary</h2>
      <p className="mb-3 text-[12.5px] text-ink-3">Value, discount, tax and exposure per channel, plus Packet-ID fill rate (the Myntra-specific join key).</p>
      <div className="mb-5 overflow-x-auto rounded-xl border border-border bg-surface shadow-sm">
        <table className="w-full min-w-[720px] text-[13px]">
          <thead>
            <tr className="bg-surface-2 text-right font-mono text-[9.5px] uppercase tracking-wide text-ink-3">
              <th className="px-3.5 py-2.5 text-left">Channel</th>
              <th className="px-3.5 py-2.5 text-right">Lines</th>
              <th className="px-3.5 py-2.5 text-right">Net Sales</th>
              <th className="px-3.5 py-2.5 text-right">Discount</th>
              <th className="px-3.5 py-2.5 text-right">Tax</th>
              <th className="px-3.5 py-2.5 text-right">Cancelled</th>
              <th className="px-3.5 py-2.5 text-right">Exceptions</th>
              <th className="px-3.5 py-2.5 text-right">Exposure</th>
              <th className="px-3.5 py-2.5 text-right">Packet ID</th>
            </tr>
          </thead>
          <tbody>
            {channels.map((c) => {
              const pkt = Math.round((100 * Number(c.packet_present)) / Number(c.lines));
              return (
                <tr key={c.channel} className="border-t border-border text-right tabular-nums">
                  <td className="px-3.5 py-2.5 text-left font-semibold text-ink">{c.channel.replace("_DROPSHIP", " DS")}</td>
                  <td className="px-3.5 py-2.5">{num(Number(c.lines))}</td>
                  <td className="px-3.5 py-2.5">{inr(Number(c.net_sales))}</td>
                  <td className="px-3.5 py-2.5">{inr(Number(c.discount))}</td>
                  <td className="px-3.5 py-2.5">{inr(Number(c.tax))}</td>
                  <td className="px-3.5 py-2.5">{num(Number(c.cancelled))}</td>
                  <td className="px-3.5 py-2.5">{Number(c.exceptions) ? num(Number(c.exceptions)) : "—"}</td>
                  <td className="px-3.5 py-2.5 font-mono text-[var(--bad,#a8402f)]">{Number(c.exposure) > 0 ? inr(Number(c.exposure)) : "—"}</td>
                  <td className={`px-3.5 py-2.5 font-mono ${pkt > 90 ? "text-[var(--good,#2f7d5d)]" : "text-[var(--bad,#a8402f)]"}`}>{pkt}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Line-level grid */}
      <h2 className="mb-1 mt-6 text-[17px] font-bold text-ink">Line-level detail</h2>
      <p className="mb-3 text-[12.5px] text-ink-3">Every order line, filterable and sortable. Toggle “Only exceptions” to focus on flagged lines.</p>
      <ReconGrid rows={lines} />
    </div>
  );
}
