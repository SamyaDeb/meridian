"use client";
import Link from "next/link";
import { useSyncExternalStore } from "react";
import { useAccount } from "wagmi";
import { Card } from "./ui";

// Onboarding card (C7): shown until the viewer connects or dismisses it. Full guide: docs/outputs/ONBOARDING.md.
const KEY = "pulse.getStarted.dismissed";
const listeners = new Set<() => void>();
let hiddenInMemory = false;

function readDismissed(): boolean {
  try {
    return globalThis.localStorage?.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function dismiss() {
  try {
    globalThis.localStorage?.setItem(KEY, "1");
  } catch {
    // storage unavailable: hidden for this page session only
    hiddenInMemory = true;
  }
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

const STEPS = [
  { title: "Trade", href: "/trade", text: "Deposit AUSD, go long or short MON-PERP. Funding settles every block." },
  { title: "Earn", href: "/earn", text: "Deposit AUSD into the basis vault; it earns funding while staying delta-neutral." },
  { title: "Fix", href: "/fix", text: "Lock a 30-day funding rate: pay or receive a fixed APR against the per-block rate." },
] as const;

export function GetStarted() {
  const { isConnected } = useAccount();
  // server snapshot = hidden, so the first client render matches the static HTML
  const dismissed = useSyncExternalStore(subscribe, () => hiddenInMemory || readDismissed(), () => true);
  if (isConnected || dismissed) return null;
  return (
    <Card
      title="Get started"
      right={
        <button type="button" onClick={dismiss} aria-label="Dismiss get started" className="-mr-2 inline-flex h-11 min-w-11 items-center justify-center text-lg text-muted">
          ×
        </button>
      }
    >
      <p className="text-sm text-muted">
        You need <span className="text-text">MON</span> for gas and <span className="text-text">AUSD</span> on Monad. Start small.
      </p>
      <ol className="mt-3 space-y-2">
        {STEPS.map((s, i) => (
          <li key={s.title} className="flex gap-3 text-sm">
            <span className="num mt-0.5 h-5 w-5 shrink-0 rounded-full bg-surface-2 text-center text-[11px] leading-5">{i + 1}</span>
            <span>
              <Link href={s.href} className="font-medium text-accent">
                {s.title}
              </Link>
              <span className="text-muted">: {s.text}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-[11px] text-muted">
        Leverage can liquidate your collateral; the vault and swaps can lose money.{" "}
        <Link href="/terms" className="underline">
          Terms &amp; risks
        </Link>
      </p>
    </Card>
  );
}
