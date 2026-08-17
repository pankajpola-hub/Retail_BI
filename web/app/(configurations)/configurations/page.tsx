import { requirePageAccess } from "@/lib/auth/roles";
import { createClient } from "@/lib/data/client";
import { getDict } from "@/lib/i18n/server";
import { FreshDiscSourceForm } from "./fresh-disc-source-form";

export const dynamic = "force-dynamic";

type AppSettingRow = { key: string; value: { source?: string } };

export default async function ConfigurationsPage() {
  // requirePageAccess (migration 0035) layers a per-user override on top of
  // the role default — (configurations)/layout.tsx's requireRole gate is
  // coarse, same reasoning as (admin)/integrations/page.tsx.
  await requirePageAccess("configurations");
  const t = await getDict();

  // core.app_settings grants SELECT to authenticated (0057) — every role
  // that ends up reading the Fresh/Disc setting via the tracker function
  // needs that, so the admin page reads it the same ordinary way, no admin
  // client needed for the read side.
  const supabase = await createClient();
  const { data: setting } = await supabase
    .schema("core")
    .from<AppSettingRow>("app_settings")
    .select("key, value")
    .eq("key", "fresh_disc_classification_source")
    .maybeSingle();

  const currentSource = setting?.value?.source === "scheme_lookup" ? "scheme_lookup" : "discount_ratio";

  return (
    <main className="py-6">
      <h1 className="font-serif text-2xl">{t.configurationsTitle}</h1>
      <p className="mt-1 max-w-2xl text-[12.5px] text-ink-3">{t.configurationsSubtitle}</p>

      <div className="mt-6 max-w-xl">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">{t.configFreshDiscSourceLabel}</h2>
        <p className="mt-1 text-[12.5px] text-ink-3">{t.configFreshDiscSourceHint}</p>
        <div className="mt-3">
          <FreshDiscSourceForm
            current={currentSource}
            labels={{
              ratio: t.configFreshDiscSourceRatio,
              ratioHint: t.configFreshDiscSourceRatioHint,
              scheme: t.configFreshDiscSourceScheme,
              schemeHint: t.configFreshDiscSourceSchemeHint,
              save: t.configSaveButton,
              saved: t.configSavedNotice,
            }}
          />
        </div>
      </div>
    </main>
  );
}
