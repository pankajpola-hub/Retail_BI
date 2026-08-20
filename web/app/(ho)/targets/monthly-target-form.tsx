"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Input, Select, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Store = { store_id: string; store_name: string };

type Step =
  | { kind: "closed" }
  | { kind: "confirm"; fresh: number; discounted: number }
  | { kind: "overwrite"; fresh: number; discounted: number; message: string }
  | { kind: "saving"; fresh: number; discounted: number }
  | { kind: "error"; message: string };

/**
 * Two-step confirmation, mirroring the footfall outlier-confirm pattern in
 * /api/footfall: first a plain "are you sure" for every save, then — only if
 * the server reports a row already exists for this store/month — a second
 * prompt showing what's there today before it gets overwritten. The second
 * step is server-driven (the message comes from the 409 response), not
 * guessed client-side, so it can't go stale relative to what's actually in
 * the database.
 */
export function MonthlyTargetForm({
  stores,
  defaultStoreId,
  defaultMonth,
}: {
  stores: Store[];
  defaultStoreId: string;
  defaultMonth: string; // "YYYY-MM"
}) {
  const router = useRouter();
  const [storeId, setStoreId] = useState(defaultStoreId);
  const [month, setMonth] = useState(defaultMonth);
  const [fresh, setFresh] = useState("");
  const [discounted, setDiscounted] = useState("");
  const [step, setStep] = useState<Step>({ kind: "closed" });

  const storeName = stores.find((s) => s.store_id === storeId)?.store_name ?? storeId;
  const monthLabel = new Date(`${month}-01T00:00:00`).toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
  });
  // "saving" carries no values of its own — it's a transient state entered
  // from whichever step the user just confirmed, so pull fresh/discounted
  // from that.
  const pending =
    step.kind === "confirm" || step.kind === "overwrite" || step.kind === "saving" ? step : null;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const f = Number(fresh);
    const d = Number(discounted);
    if (!Number.isInteger(f) || f < 0 || !Number.isInteger(d) || d < 0) return;
    setStep({ kind: "confirm", fresh: f, discounted: d });
  }

  async function save(confirmOverwrite: boolean) {
    if (step.kind !== "confirm" && step.kind !== "overwrite") return;
    const { fresh: f, discounted: d } = step;
    setStep({ kind: "saving", fresh: f, discounted: d });

    const res = await fetch("/api/targets/monthly", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        store_id: storeId,
        period_month: month,
        fresh_target_qty: f,
        discounted_target_qty: d,
        confirmed_overwrite: confirmOverwrite,
      }),
    });
    const body = await res.json();

    if (body.ok) {
      setStep({ kind: "closed" });
      setFresh("");
      setDiscounted("");
      router.refresh();
      return;
    }
    if (body.error.code === "needs_confirmation") {
      setStep({ kind: "overwrite", fresh: f, discounted: d, message: body.error.message });
      return;
    }
    setStep({ kind: "error", message: body.error.message });
  }

  return (
    <>
      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3 border border-line-soft p-4">
        <Label className="flex flex-col gap-1">
          <span className="text-ink-3">Store</span>
          <Select value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            {stores.map((s) => (
              <option key={s.store_id} value={s.store_id}>
                {s.store_name}
              </option>
            ))}
          </Select>
        </Label>
        <Label className="flex flex-col gap-1">
          <span className="text-ink-3">Month</span>
          <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} required />
        </Label>
        <Label className="flex flex-col gap-1">
          <span className="text-ink-3">Fresh target (units)</span>
          <Input type="number" min={0} inputMode="numeric" value={fresh} onChange={(e) => setFresh(e.target.value)} required className="w-32" />
        </Label>
        <Label className="flex flex-col gap-1">
          <span className="text-ink-3">Discounted target (units)</span>
          <Input type="number" min={0} inputMode="numeric" value={discounted} onChange={(e) => setDiscounted(e.target.value)} required className="w-32" />
        </Label>
        <Button type="submit" disabled={step.kind === "saving"}>Set targets</Button>
      </form>

      {step.kind === "error" && (
        <p className="mt-2 border-l-2 border-crit bg-crit-soft px-3 py-2 text-sm text-ink-2">
          {step.message}
        </p>
      )}

      <Dialog
        open={step.kind === "confirm" || step.kind === "overwrite" || step.kind === "saving"}
        onOpenChange={(open) => {
          if (!open && step.kind !== "saving") setStep({ kind: "closed" });
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className={step.kind === "overwrite" ? "text-warn" : ""}>
              {step.kind === "overwrite" ? "Targets already set" : "Confirm targets"}
            </DialogTitle>
          </DialogHeader>
          {step.kind === "overwrite" ? (
            <>
              <p className="mt-2 text-[13px] text-ink-2">{step.message}</p>
              <p className="mt-2 text-[13px] text-ink-2">
                New values — Fresh <span className="font-mono">{pending?.fresh}</span>, Discounted{" "}
                <span className="font-mono">{pending?.discounted}</span>.
              </p>
            </>
          ) : (
            <p className="mt-2 text-[13px] text-ink-2">
              Set {storeName} — {monthLabel} to Fresh <span className="font-mono">{pending?.fresh ?? ""}</span>,
              Discounted <span className="font-mono">{pending?.discounted ?? ""}</span>?
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setStep({ kind: "closed" })} disabled={step.kind === "saving"}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => save(step.kind === "overwrite")} disabled={step.kind === "saving"}>
              {step.kind === "saving" ? "Saving…" : step.kind === "overwrite" ? "Overwrite" : "Confirm"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
