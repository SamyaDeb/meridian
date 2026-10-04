"use client";
import Link from "next/link";
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { TERMS_STATUS, TERMS_SUMMARY } from "@/content/terms";
import { isGeoRestricted } from "@/lib/geo";
import { isAccepted, readAcceptance, writeAcceptance } from "@/lib/terms";

/** `ensure()` resolves true when a write may go ahead: terms accepted (asks once per version) and not geo-restricted. */
type Gate = { ensure: () => Promise<boolean> };
const GateContext = createContext<Gate>({ ensure: async () => true });

export function useWriteGate(): Gate {
  return useContext(GateContext);
}

type Dialog = "terms" | "restricted" | null;

export function WriteGateProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [checked, setChecked] = useState(false);
  const acceptedThisSession = useRef(false);
  const pending = useRef<((ok: boolean) => void) | null>(null);

  const ensure = useCallback(async () => {
    if (isGeoRestricted(typeof document === "undefined" ? undefined : document.cookie)) {
      setDialog("restricted");
      return false;
    }
    if (acceptedThisSession.current || isAccepted(readAcceptance())) return true;
    setChecked(false);
    setDialog("terms");
    return new Promise<boolean>((resolve) => {
      pending.current = resolve;
    });
  }, []);

  const close = (ok: boolean) => {
    if (ok) {
      acceptedThisSession.current = true;
      writeAcceptance(Date.now());
    }
    setDialog(null);
    pending.current?.(ok);
    pending.current = null;
  };

  return (
    <GateContext.Provider value={{ ensure }}>
      {children}
      {dialog && (
        <div role="dialog" aria-modal="true" aria-labelledby="gate-title" className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center">
          <div className="max-h-[85dvh] w-full max-w-[430px] overflow-y-auto rounded-t-2xl border border-border bg-surface p-4 pb-[calc(16px+env(safe-area-inset-bottom))] sm:rounded-2xl">
            {dialog === "restricted" ? (
              <>
                <h2 id="gate-title" className="text-base font-semibold">Not available in your region</h2>
                <p className="mt-2 text-sm text-muted">Trading, deposits and other write actions aren&apos;t available from your location. You can still browse markets and stats.</p>
                <button type="button" onClick={() => close(false)} className="mt-4 h-12 w-full rounded-xl bg-surface-2 font-semibold">
                  OK
                </button>
              </>
            ) : (
              <>
                <h2 id="gate-title" className="text-base font-semibold">Before your first transaction</h2>
                {TERMS_STATUS === "draft" && <p className="mt-1 text-[11px] font-medium uppercase text-warn">Draft terms: pending founder sign-off</p>}
                <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-muted">
                  {TERMS_SUMMARY.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
                <Link href="/terms" target="_blank" className="mt-3 inline-block text-sm text-accent underline">
                  Read the full terms and risk disclosure
                </Link>
                <label className="mt-4 flex min-h-11 items-center gap-3 text-sm">
                  <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="h-5 w-5 accent-[var(--accent)]" />I have read and accept the terms and risks
                </label>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => close(false)} className="h-12 rounded-xl bg-surface-2 text-sm">
                    Cancel
                  </button>
                  <button type="button" disabled={!checked} onClick={() => close(true)} className="h-12 rounded-xl bg-accent text-sm font-semibold text-bg disabled:opacity-50">
                    Accept
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </GateContext.Provider>
  );
}
