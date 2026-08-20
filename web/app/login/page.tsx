import { login } from "./actions";
import { getDict } from "@/lib/i18n/server";
import { Input, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: { next?: string; error?: string; email?: string };
}) {
  const t = await getDict();

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-6">
      <h1 className="font-serif text-3xl">{t.appName}</h1>

      {searchParams.error === "not_provisioned" && (
        <p className="border-l-2 border-warn bg-warn-soft px-3 py-2 text-sm text-ink-2">
          {t.errNotProvisioned}
        </p>
      )}
      {searchParams.error && searchParams.error !== "not_provisioned" && (
        <p className="border-l-2 border-crit bg-crit-soft px-3 py-2 text-sm text-ink-2">
          {decodeURIComponent(searchParams.error)}
        </p>
      )}

      <form action={login} className="flex flex-col gap-3">
        <input type="hidden" name="next" value={searchParams.next ?? "/"} />
        <Label className="flex flex-col gap-1.5">
          {t.email}
          <Input
            name="email"
            type="email"
            required
            defaultValue={searchParams.email ?? ""}
            autoFocus={!searchParams.email}
          />
        </Label>
        <Label className="flex flex-col gap-1.5">
          {t.password}
          <Input name="password" type="password" required autoFocus={!!searchParams.email} />
        </Label>
        <Button type="submit" className="mt-2">
          {t.signIn}
        </Button>
      </form>

      {/*
        No self-service "forgot password" and no Google sign-in: both were
        Supabase-Auth features (its mailer / its OAuth) and went with it.
        Keycloak could do either — realm SMTP for reset emails, an identity
        provider for Google — but neither is configured on this realm, so
        rather than leave visibly broken buttons, password resets go through a
        Super Admin on the Users page. Re-add here if/when the realm gains SMTP.
      */}
      <p className="text-center text-[12.5px] text-ink-3">
        Forgotten your password? Ask a Super Admin to reset it from the Users page.
      </p>
    </main>
  );
}
