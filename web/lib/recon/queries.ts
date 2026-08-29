import { createClient, fetchAllRows } from "@/lib/data/client";

// Marketplace reconciliation read helpers. All reads go through the existing
// self-hosted PostgREST client (lib/data/client.ts) against the ops schema
// objects added in migration 0098. Read-only; the recon pages never write.

export type ReconChannelSummary = {
  channel: string;
  lines: number;
  orders: number;
  net_sales: number;
  discount: number;
  tax: number;
  delivered: number;
  dispatched: number;
  cancelled: number;
  exceptions: number;
  exposure: number;
  packet_present: number;
  hsn_present: number;
  invoice_present: number;
};

export type ReconExceptionSummary = {
  exception_code: string;
  severity: string;
  n: number;
  exposure: number;
};

export type ReconLine = {
  id: number;
  channel: string;
  order_code: string | null;
  sku: string | null;
  status: string | null;
  order_date: string | null;
  mrp: number | null;
  selling_price: number | null;
  total_price: number | null;
  discount: number | null;
  exception_code: string;
  exception_severity: string;
  exception_amount: number;
};

export async function getReconChannelSummary(): Promise<ReconChannelSummary[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema("ops")
    .from("recon_channel_summary")
    .select("*")
    .order("net_sales", { ascending: false });
  if (error) throw new Error(`recon_channel_summary: ${error.message}`);
  return (data ?? []) as ReconChannelSummary[];
}

export async function getReconExceptionSummary(): Promise<ReconExceptionSummary[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema("ops")
    .from("recon_exception_summary")
    .select("*");
  if (error) throw new Error(`recon_exception_summary: ${error.message}`);
  return (data ?? []) as ReconExceptionSummary[];
}

export async function getReconLines(): Promise<ReconLine[]> {
  const supabase = await createClient();
  // fetchAllRows, not a bare .limit() — PostgREST's own "Max Rows" setting
  // silently caps any single request at 1000 regardless of a higher
  // .limit(), so a 2,399-row seed (let alone the live-refreshed table) would
  // have quietly shown only its first ~1000 rows with no error. order("id")
  // gives .range() pagination a stable, gapless cursor (the table's own
  // identity column).
  const data = await fetchAllRows<ReconLine>(() =>
    supabase
      .schema("ops")
      .from<ReconLine>("recon_lines")
      .select(
        "id, channel, order_code, sku, status, order_date, mrp, selling_price, total_price, discount, exception_code, exception_severity, exception_amount"
      )
      .order("id", { ascending: true })
  );
  return data.sort((a, b) => (b.order_date ?? "").localeCompare(a.order_date ?? ""));
}
