import { createClient } from "@/lib/data/client";
import { requirePageAccess } from "@/lib/auth/roles";
import { getDict } from "@/lib/i18n/server";
import { StoreFilter } from "@/components/ui/StoreFilter";
import { DateRangePicker } from "@/components/ui/DateRangePicker";
import { FootfallCounter } from "./footfall-counter";

export const dynamic = "force-dynamic";

type ExistingFootfall = { footfall: number };
type DayStats = { sale_bills: number; net_sales: number };
type CompletenessRow = { date: string; has_footfall: boolean; footfall: number | null; remarks: string | null };
type Store = { store_id: string; store_name: string; is_active: boolean };

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export default async function FootfallPage({
  searchParams,
}: {
  searchParams: { store?: string; from?: string; to?: string };
}) {
  // requirePageAccess (migration 0035) layers a per-user override on top of
  // the role default — (ebo)/layout.tsx's gate is coarse (it also hosts
  // /my-store, a different page_key), so the "footfall" page_key check has
  // to happen here instead.
  const user = await requirePageAccess("footfall");
  const t = await getDict();

  if (user.storeIds.length === 0) {
    return <p className="py-8 text-warn">{t.noStoreAssigned}</p>;
  }

  // Only honour ?store= if the caller actually has that store. RLS would
  // reject the write anyway, but falling back here means a stale or hand-typed
  // URL shows a working screen for a store they DO have, instead of a
  // half-broken one that only fails at save time.
  const requested = searchParams.store;
  const storeId =
    requested && user.storeIds.includes(requested) ? requested : (user.storeIds[0] as string);

  const supabase = await createClient();
  const today = new Date();
  const todayIso = isoDate(today);

  // Same default window as the Network page (28 days, today inclusive) so
  // the two date pickers behave identically out of the box.
  const defaultFrom = new Date(today);
  defaultFrom.setDate(defaultFrom.getDate() - 27);
  const from = searchParams.from ?? isoDate(defaultFrom);
  const to = searchParams.to ?? todayIso;

  const [{ data: existing }, { data: dayStats }, { data: recent }, { data: stores }] = await Promise.all([
    supabase
      .schema("ops")
      .from<ExistingFootfall>("ebo_footfall_daily")
      .select("footfall")
      .eq("store_id", storeId)
      .eq("date", todayIso)
      .maybeSingle(),
    supabase
      .schema("sales")
      .from<DayStats>("vw_ebo_sales_daily")
      .select("sale_bills, net_sales")
      .eq("store_id", storeId)
      .eq("bill_date", todayIso)
      .maybeSingle(),
    supabase
      .schema("ops")
      .from<CompletenessRow>("vw_footfall_completeness")
      .select("date, has_footfall, footfall, remarks")
      .eq("store_id", storeId)
      .gte("date", from)
      .lte("date", to)
      .order("date", { ascending: false }),
    supabase.schema("core").from<Store>("stores").select("store_id, store_name, is_active").order("store_id"),
  ]);

  const missingCount = (recent ?? []).filter((r) => !r.has_footfall).length;

  // core.stores is RLS-filtered to the caller's permitted stores already,
  // so this list can't offer a store they aren't allowed to write to.
  // Inactive stores (core.stores.is_active = false) are kept visible only on
  // /network for historical reference, hidden here.
  const selectableStores = (stores ?? []).filter((s) => s.is_active);

  return (
    <main className="py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-serif text-xl">{t.footfallTitle}</h1>
          <p className="mt-1 text-[12.5px] text-ink-3">{t.footfallSubtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {selectableStores.length > 1 && (
            <StoreFilter stores={selectableStores} selected={storeId} allowAll={false} label={t.store} />
          )}
          <DateRangePicker from={from} to={to} />
          <a
            href={`/api/footfall/download?store=${encodeURIComponent(storeId)}&from=${encodeURIComponent(
              from
            )}&to=${encodeURIComponent(to)}`}
            className="min-h-[36px] border border-line bg-surface px-3 py-1.5 text-[13px] text-ink-2 hover:bg-surface-2"
          >
            Download report
          </a>
        </div>
      </div>

      {/*
        key={storeId} is load-bearing: the counter keeps the current count in
        local state, so without a remount on store change it would keep
        showing (and saving) the previous store's number.
      */}
      <FootfallCounter
        key={storeId}
        storeId={storeId}
        today={todayIso}
        initialFootfall={existing?.footfall ?? 0}
        todayStats={{
          bills: dayStats?.sale_bills ?? 0,
          netSales: Number(dayStats?.net_sales ?? 0),
        }}
        t={t}
      />

      <div className="mt-8">
        <div className="flex items-baseline justify-between">
          <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
            {from === to ? from : `${from} – ${to}`}
          </span>
          {missingCount > 0 && (
            <span className="text-[12px] text-warn">
              {missingCount} {t.daysMissing}
            </span>
          )}
        </div>
        <div className="mt-2 overflow-x-auto border border-line-soft">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line-soft bg-surface-2 text-left text-[10px] uppercase tracking-wide text-ink-3">
                <th className="px-3 py-2">{t.date}</th>
                <th className="px-3 py-2 text-right">{t.footfallLabel}</th>
                <th className="px-3 py-2">{t.remarks}</th>
              </tr>
            </thead>
            <tbody>
              {(recent ?? []).map((r) => (
                <tr key={r.date} className="border-b border-line-soft last:border-0">
                  <td className="px-3 py-1.5">
                    {new Date(r.date + "T00:00:00").toLocaleDateString("en-IN", {
                      weekday: "short",
                      day: "2-digit",
                      month: "short",
                    })}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono">
                    {r.has_footfall ? r.footfall : <span className="text-warn">{t.notEntered}</span>}
                  </td>
                  <td className="px-3 py-1.5 text-[12px] text-ink-3">{r.remarks ?? ""}</td>
                </tr>
              ))}
              {(recent ?? []).length === 0 && (
                <tr>
                  <td colSpan={3} className="px-3 py-4 text-center text-sm text-ink-3">
                    No footfall entries in this range.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
