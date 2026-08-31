import { createClient } from "@/lib/data/client";
import { resolveAccess } from "@/lib/auth/access";
import { UploadReportForm } from "./upload-form";
import { ProcessButton } from "./process-button";
import { MergedSaleDownload } from "./merged-sale-download";
import { getDict } from "@/lib/i18n/server";
import type { Dict } from "@/lib/i18n/translations";

export const dynamic = "force-dynamic";

type UploadRow = {
  id: string;
  report_type: "sale" | "stock" | "scheme" | "master" | "channel_summary";
  file_name: string;
  uploaded_at: string;
  status: string;
  notes: string | null;
};

function ReportSection({
  title,
  helperText,
  type,
  uploads,
  fiscalYears,
  canProcess,
  t,
}: {
  title: string;
  helperText?: string;
  type: UploadRow["report_type"];
  uploads: UploadRow[];
  fiscalYears: string[];
  canProcess: boolean;
  t: Dict;
}) {
  return (
    <div className="mt-8">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">{title}</h2>
      </div>
      {helperText ? <p className="mt-1 max-w-2xl text-[12.5px] text-ink-3">{helperText}</p> : null}
      <div className="mt-3">
        <UploadReportForm reportType={type} />
      </div>
      <ul className="mt-4 divide-y divide-line-soft border border-line-soft">
        {type === "sale" ? <MergedSaleDownload fiscalYears={fiscalYears} /> : null}
        {uploads.length === 0 ? (
          <li className="px-3 py-2 text-sm text-ink-3">{t.noFilesUploadedYet}</li>
        ) : (
          uploads.map((u) => (
            <li key={u.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span className="flex flex-col">
                <span>{u.file_name}</span>
                <span className="text-[11px] text-ink-3">
                  {t.statusLabel}: <span className={u.status === "failed" ? "text-crit" : u.status === "processed" ? "text-good" : ""}>{u.status}</span>
                  {u.notes ? ` — ${u.notes}` : ""}
                </span>
              </span>
              <span className="flex items-center gap-3 text-ink-3">
                <span className="text-[12px]">
                  {new Date(u.uploaded_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
                </span>
                <a
                  href={`/api/data-upload/download/${u.id}`}
                  className="border border-line px-2 py-1 text-[11px] uppercase tracking-wide text-ink-2 hover:text-ink"
                >
                  {t.download}
                </a>
                {/* 'admin' class: processing COMMITS an upload into the
                    warehouse tables, so it's separable from merely being able
                    to see or download what was uploaded. */}
                {canProcess && <ProcessButton uploadId={u.id} />}
              </span>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

export default async function DataUploadPage() {
  const supabase = await createClient();
  const t = await getDict();
  // 0079 feature gate. This page's route-level access is handled by its
  // layout's requirePageAccess("data-upload").
  const access = await resolveAccess();
  const canProcess = access?.can("data-upload.process.admin") ?? true;

  const SECTIONS: { type: UploadRow["report_type"]; title: string; helperText?: string }[] = [
    { type: "sale", title: t.saleReportTitle },
    { type: "stock", title: t.stockReportTitle },
    { type: "scheme", title: t.schemeReportTitle },
    // Literal title/helper rather than a `t.` key: lib/i18n/translations.ts is
    // being edited concurrently for other work, so this section deliberately
    // doesn't add a key to it. Worth moving to the dictionary later.
    {
      type: "master",
      title: "Master",
      helperText:
        "Fills product attributes (category, gender, subcategory, season, size) matched by item code, for items whose sale export didn't carry them.",
    },
    // Sale Summary (0101) — wholesale/distribution-channel sales feeding
    // /sale-summary. Literal title/helper, same reasoning as "master"
    // above: not worth a dictionary key on a page this app doesn't
    // translate (see translations.ts's own header on which surfaces are
    // in scope).
    {
      type: "channel_summary",
      title: "Sale Summary (channel sales)",
      helperText:
        "Monthly pre-aggregated wholesale/distribution-channel sales — agents, distributors, LFS, MBO, ecommerce marketplaces. One row per branch × month × party × channel; re-uploading a month updates it, never duplicates. Feeds /sale-summary.",
    },
  ];

  const [{ data }, { data: fyRows }] = await Promise.all([
    supabase
      .schema("ops")
      .from<UploadRow>("erp_report_uploads")
      .select("id, report_type, file_name, uploaded_at, status, notes")
      .order("uploaded_at", { ascending: false }),
    // Distinct fiscal years actually present in the merged sale data right
    // now (migration 0033) — drives the Sale report section's FY
    // multi-select. Never hardcoded, so a new fiscal year just appears here
    // once its first Sale report is processed.
    supabase
      .schema("sales")
      .from<{ financial_year: string }>("vw_sale_transactions_fiscal_years")
      .select("financial_year"),
  ]);

  const uploads = data ?? [];
  const fiscalYears = (fyRows ?? []).map((r) => r.financial_year);

  return (
    <main className="py-6">
      <h1 className="font-serif text-2xl">{t.dataUploadTitle}</h1>
      <p className="mt-1 max-w-2xl text-[12.5px] text-ink-3">{t.dataUploadSubtitle}</p>

      {SECTIONS.map((s) => (
        <ReportSection
          key={s.type}
          title={s.title}
          helperText={s.helperText}
          type={s.type}
          uploads={uploads.filter((u) => u.report_type === s.type)}
          fiscalYears={fiscalYears}
          canProcess={canProcess}
          t={t}
        />
      ))}
    </main>
  );
}
