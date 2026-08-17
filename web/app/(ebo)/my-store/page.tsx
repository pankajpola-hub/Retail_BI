import { requireRole } from "@/lib/auth/roles";
import { createClient } from "@/lib/data/client";
import { KpiCard } from "@/components/ui/KpiCard";
import { getDict } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

type VwEboSalesWeeklyRow = {
  is_complete_week: boolean;
  net_sales: number | string;
  sale_bills: number | string;
};

export default async function MyStorePage() {
  const user = await requireRole("ebo_manager");
  const storeId = user.storeIds[0];
  const supabase = await createClient();
  const t = await getDict();

  const { data: week } = storeId
    ? await supabase
        .schema("sales")
        .from<VwEboSalesWeeklyRow>("vw_ebo_sales_weekly")
        .select("*")
        .eq("store_id", storeId)
        .order("week_start", { ascending: false })
        .limit(1)
        .maybeSingle()
    : { data: null };

  return (
    <main className="py-6">
      <h1 className="font-serif text-2xl">{t.myStoreTitle}</h1>

      <div className="mt-5 grid grid-cols-2 gap-3">
        <KpiCard
          label={week?.is_complete_week ? "Last complete week" : "This week so far"}
          value={week ? `₹${Number(week.net_sales).toLocaleString("en-IN")}` : "—"}
          tone={week ? "default" : "muted"}
        />
        <KpiCard label="Bills" value={week ? String(week.sale_bills) : "—"} />
      </div>

      <p className="mt-6 text-sm text-ink-3">
        Scaffold placeholder — the full screen (diagnosis, action buttons,
        pending items) is mock screen 04; the diagnosis card should call{" "}
        <code className="font-mono text-xs">
          supabase.schema(&apos;ops&apos;).rpc(&apos;fn_diagnose_store&apos;)
        </code>
        .
      </p>
    </main>
  );
}
