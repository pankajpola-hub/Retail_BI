import { createClient } from "@/lib/data/client";
import { getDict } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

type CampaignRow = {
  id: number | string;
  campaign_name: string;
  campaign_date: string;
  campaign_status: string;
};

export default async function CampaignsPage() {
  const supabase = await createClient();
  const t = await getDict();
  const { data: campaigns } = await supabase
    .schema("marketing")
    .from<CampaignRow>("campaigns")
    .select("id, campaign_name, campaign_date, campaign_status")
    .order("campaign_date", { ascending: false });

  return (
    <main className="py-6">
      <h1 className="font-serif text-2xl">{t.campaignsTitle}</h1>
      <p className="mt-1 text-[12.5px] text-ink-3">
        Placeholder list — the full performance view (screen 07: delivery
        funnel, failure-reason breakdown, store impact) reads from
        marketing.vw_campaign_metrics / vw_campaign_failure_reasons /
        vw_campaign_store_impact.
      </p>
      <ul className="mt-4 divide-y divide-line-soft border border-line-soft">
        {campaigns?.map((c) => (
          <li key={c.id} className="flex justify-between px-3 py-2 text-sm">
            <span>{c.campaign_name}</span>
            <span className="text-ink-3">{c.campaign_status}</span>
          </li>
        )) ?? <li className="px-3 py-2 text-sm text-ink-3">No campaigns yet.</li>}
      </ul>
    </main>
  );
}
