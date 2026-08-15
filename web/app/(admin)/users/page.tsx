import { createClient } from "@/lib/data/client";
import type { AppRole, PageKey } from "@/lib/auth/roles";
import { requirePageAccess } from "@/lib/auth/roles";
import { InviteUserForm } from "./invite-user-form";
import { ResetPasswordButton } from "./reset-password-button";
import { RenameUserButton } from "./rename-user-button";
import { StoreAccessButton } from "./store-access-button";
import { PageAccessButton } from "./page-access-button";

import { getDict } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

type Profile = { user_id: string; full_name: string; role: AppRole };
type Store = { store_id: string; store_name: string };
type Grant = { user_id: string; store_id: string };
type PageOverride = { user_id: string; page_key: PageKey; allowed: boolean };

export default async function UsersPage() {
  // requirePageAccess (migration 0035) layers a per-user override on top of
  // the role default — (admin)/layout.tsx's gate is coarse (it also hosts
  // /integrations, a different page_key), so the "users" page_key check has
  // to happen here instead.
  await requirePageAccess("users");

  const supabase = await createClient();
  const t = await getDict();

  const [{ data: profiles }, { data: stores }, { data: grants }, { data: pageOverrides }] = await Promise.all([
    supabase.schema("core").from<Profile>("profiles").select("user_id, full_name, role"),
    supabase.schema("core").from<Store>("stores").select("store_id, store_name").order("store_id"),
    supabase.schema("core").from<Grant>("user_store_access").select("user_id, store_id"),
    supabase.schema("core").from<PageOverride>("user_page_overrides").select("user_id, page_key, allowed"),
  ]);

  // BO-004 (Phoenix Palassio, Lucknow) is discontinued — kept visible only
  // on /network for historical reference; not offered as a store to grant
  // access to.
  const activeStores = (stores ?? []).filter((s) => s.store_id !== "BO-004");

  const storesByUser = new Map<string, string[]>();
  for (const g of grants ?? []) {
    storesByUser.set(g.user_id, [...(storesByUser.get(g.user_id) ?? []), g.store_id]);
  }

  const pageOverridesByUser = new Map<string, Partial<Record<PageKey, boolean>>>();
  for (const o of pageOverrides ?? []) {
    const existing = pageOverridesByUser.get(o.user_id) ?? {};
    existing[o.page_key] = o.allowed;
    pageOverridesByUser.set(o.user_id, existing);
  }

  return (
    <main className="py-6">
      <h1 className="font-serif text-2xl">{t.usersTitle}</h1>
      <p className="mt-1 text-[12.5px] text-ink-3">{t.usersSubtitle}</p>

      <div className="mt-4">
        <InviteUserForm stores={activeStores} />
      </div>

      <h2 className="mt-8 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
        {t.existingUsersTitle}
      </h2>
      <ul className="mt-2 divide-y divide-line-soft border border-line-soft">
        {profiles?.map((p) => (
          <li key={p.user_id} className="flex flex-col gap-1 px-3 py-2 text-sm">
            <span className="flex items-center justify-between">
              <span>{p.full_name}</span>
              <span className="flex items-center gap-3 text-ink-3">
                {storesByUser.get(p.user_id)?.length ? (
                  <span className="text-[12px]">{storesByUser.get(p.user_id)!.join(", ")}</span>
                ) : null}
                <span className="font-mono text-[11px] uppercase tracking-wide">{p.role}</span>
                <RenameUserButton userId={p.user_id} fullName={p.full_name} />
                <StoreAccessButton
                  userId={p.user_id}
                  userName={p.full_name}
                  stores={activeStores}
                  currentStoreIds={storesByUser.get(p.user_id) ?? []}
                />
                <PageAccessButton
                  userId={p.user_id}
                  userName={p.full_name}
                  currentOverrides={pageOverridesByUser.get(p.user_id) ?? {}}
                />
                <ResetPasswordButton userId={p.user_id} userName={p.full_name} />
              </span>
            </span>
          </li>
        )) ?? <li className="px-3 py-2 text-sm text-ink-3">{t.noUsersYet}</li>}
      </ul>
    </main>
  );
}
