"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import type { Dict } from "@/lib/i18n/translations";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

const INR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

type DayStat = { bills: number; netSales: number };

/**
 * Two entry modes on purpose:
 *   - Today: tap "+" or type the number directly. Meets the <10s target.
 *   - Another date: backfill or correct a past day, with remarks.
 *
 * Performance note: taps update local state INSTANTLY and the save is
 * debounced ~700ms, so holding "+" ten times fires one request, not ten.
 * router.refresh() is deliberately NOT called on save — it re-runs the whole
 * server page (3 DB queries) and was what made every tap feel slow. Nothing
 * on this screen actually changes as a result of the save: bills/net sales
 * come from the ERP and are unaffected by footfall, and conversion /
 * sales-per-visitor are derived client-side from the number already on
 * screen.
 */
export function FootfallCounter({
  storeId,
  today,
  initialFootfall,
  todayStats,
  t,
}: {
  storeId: string;
  today: string;
  initialFootfall: number;
  todayStats: DayStat;
  t: Dict;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"today" | "other">("today");
  const [footfall, setFootfall] = useState(initialFootfall);
  const [typedValue, setTypedValue] = useState(String(initialFootfall));
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "pending" | "saved">("idle");

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef(initialFootfall);

  // "other date" form state
  const [otherDate, setOtherDate] = useState(today);
  const [otherValue, setOtherValue] = useState("");
  const [remarks, setRemarks] = useState("");
  const [pendingConfirm, setPendingConfirm] = useState<string | null>(null);
  const [savedOther, setSavedOther] = useState(false);

  const flush = useCallback(
    async (value: number) => {
      if (value === lastSavedRef.current) {
        setSaveState("idle");
        return;
      }
      const res = await fetch("/api/footfall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ store_id: storeId, date: today, footfall: value, confirmed_outlier: true }),
      });
      const body = await res.json();
      if (body.ok) {
        lastSavedRef.current = value;
        setSaveState("saved");
        setError(null);
      } else {
        setSaveState("idle");
        setError(body.error.message);
      }
    },
    [storeId, today]
  );

  function scheduleSave(value: number) {
    setSaveState("pending");
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => flush(value), 700);
  }

  // Don't lose the last taps if the user navigates away mid-debounce.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  function bump(delta: number) {
    const next = Math.max(0, footfall + delta);
    setFootfall(next);
    setTypedValue(String(next));
    scheduleSave(next);
  }

  function onType(raw: string) {
    setTypedValue(raw);
    const n = Number(raw);
    if (raw === "" || !Number.isInteger(n) || n < 0) return;
    setFootfall(n);
    scheduleSave(n);
  }

  async function saveOther(e: React.FormEvent, confirmed = false) {
    e.preventDefault();
    setError(null);
    setSavedOther(false);
    const value = Number(otherValue);
    if (!Number.isInteger(value) || value < 0) {
      setError(t.enterWholeNumber);
      return;
    }
    const res = await fetch("/api/footfall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        store_id: storeId,
        date: otherDate,
        footfall: value,
        remarks: remarks || undefined,
        confirmed_outlier: confirmed,
      }),
    });
    const body = await res.json();
    if (body.ok) {
      setSavedOther(true);
      setPendingConfirm(null);
      setOtherValue("");
      setRemarks("");
      router.refresh(); // here it IS needed — the 14-day table below changes
      return;
    }
    if (body.error.code === "needs_confirmation") {
      setPendingConfirm(body.error.message);
      return;
    }
    setError(body.error.message);
  }

  const conversionPct = footfall > 0 ? ((todayStats.bills / footfall) * 100).toFixed(1) : null;
  const salesPerVisitor = footfall > 0 ? todayStats.netSales / footfall : null;
  const nonConverting = footfall > 0 ? footfall - todayStats.bills : null;

  return (
    <div className="mt-5">
      <div className="flex gap-1 border-b border-line-soft text-[13px]">
        <button
          onClick={() => setMode("today")}
          className={`px-3 py-2 ${mode === "today" ? "border-b-2 border-accent font-semibold text-ink" : "text-ink-3"}`}
        >
          {t.tabToday}
        </button>
        <button
          onClick={() => setMode("other")}
          className={`px-3 py-2 ${mode === "other" ? "border-b-2 border-accent font-semibold text-ink" : "text-ink-3"}`}
        >
          {t.tabAnotherDate}
        </button>
      </div>

      {mode === "today" ? (
        <div className="flex flex-col items-center gap-5 border border-t-0 border-line-soft p-6">
          <div className="w-full text-center">
            <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
              {t.peopleEnteredToday}
            </span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              value={typedValue}
              onChange={(e) => onType(e.target.value)}
              onBlur={() => {
                if (typedValue === "") {
                  setTypedValue(String(footfall));
                }
              }}
              aria-label="Footfall count — type directly or use the buttons below"
              className="mt-1 w-full border-0 bg-transparent text-center font-mono text-6xl tabular-nums text-ink focus:outline-none focus:ring-0"
            />
            <div className="h-4 text-[11px] text-ink-3">
              {saveState === "pending" && t.saving}
              {saveState === "saved" && t.saved}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => bump(-1)}
              disabled={footfall === 0}
              aria-label="Decrease by 1"
              className="h-14 w-14 border border-line text-2xl text-ink-2 disabled:opacity-40"
            >
              −
            </button>
            <button
              onClick={() => bump(1)}
              aria-label="Increase by 1"
              className="h-20 w-20 bg-accent text-4xl font-semibold text-white"
            >
              +
            </button>
            <button
              onClick={() => bump(5)}
              className="h-14 border border-line px-3 text-sm text-ink-2"
            >
              +5
            </button>
          </div>

          {error && (
            <p className="w-full border-l-2 border-crit bg-crit-soft px-3 py-2 text-sm text-ink-2">{error}</p>
          )}

          <div className="w-full border-t border-line-soft pt-4 text-sm">
            <div className="flex justify-between py-0.5">
              <span className="text-ink-3">{t.billsToday}</span>
              <span className="font-mono tabular-nums">{todayStats.bills}</span>
            </div>
            <div className="flex justify-between py-0.5">
              <span className="text-ink-3">{t.conversion}</span>
              <span className="font-mono tabular-nums">{conversionPct !== null ? `${conversionPct}%` : "—"}</span>
            </div>
            <div className="flex justify-between py-0.5">
              <span className="text-ink-3">{t.salesPerVisitor}</span>
              <span className="font-mono tabular-nums">
                {salesPerVisitor !== null ? INR(salesPerVisitor) : "—"}
              </span>
            </div>
            <div className="flex justify-between py-0.5">
              <span className="text-ink-3">{t.nonConvertingVisits}</span>
              <span className="font-mono tabular-nums">{nonConverting !== null ? nonConverting : "—"}</span>
            </div>
            <div className="flex justify-between py-0.5">
              <span className="text-ink-3">{t.netSales}</span>
              <span className="font-mono tabular-nums">{INR(todayStats.netSales)}</span>
            </div>
          </div>
        </div>
      ) : (
        <form
          onSubmit={(e) => saveOther(e)}
          className="flex flex-col gap-3 border border-t-0 border-line-soft p-5"
        >
          <label className="flex flex-col gap-1 text-sm">
            {t.date}
            <Input type="date" max={today} value={otherDate} onChange={(e) => setOtherDate(e.target.value)} required />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t.footfallLabel}
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              value={otherValue}
              onChange={(e) => setOtherValue(e.target.value)}
              required
              className="font-mono text-lg"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t.remarks} <span className="text-[11px] text-ink-3">{t.remarksHint}</span>
            <Input type="text" maxLength={500} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </label>

          {pendingConfirm ? (
            <div className="border-l-2 border-warn bg-warn-soft px-3 py-2">
              <p className="text-sm text-ink-2">{pendingConfirm}</p>
              <div className="mt-2 flex gap-2">
                <Button type="button" size="sm" onClick={(e) => saveOther(e as unknown as React.FormEvent, true)}>
                  {t.saveAnyway}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setPendingConfirm(null)}>
                  {t.letMeFixIt}
                </Button>
              </div>
            </div>
          ) : (
            <Button type="submit" className="self-start">
              {t.save}
            </Button>
          )}

          {error && (
            <p className="border-l-2 border-crit bg-crit-soft px-3 py-2 text-sm text-ink-2">{error}</p>
          )}
          {savedOther && (
            <p className="border-l-2 border-good bg-good-soft px-3 py-2 text-sm text-ink-2">{t.saved}</p>
          )}
        </form>
      )}
    </div>
  );
}
