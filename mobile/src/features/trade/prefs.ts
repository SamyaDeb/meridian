// G3 (owner, 9 Oct): Trade opens in Lite; Pro is remembered on this device. A non-secret preference, stored next to
// the app's other non-secret prefs (SecureStore KV, MOBILE_PLAN §2 libraries). Anything unreadable ⇒ Lite.
import { useEffect, useState } from "react";
import type { KV } from "../../auth/credentialStore";

export type TradeView = "lite" | "pro";
export const TRADE_VIEW_KEY = "meridian.pref.tradeView";

export async function loadTradeView(kv: KV): Promise<TradeView> {
  try {
    return (await kv.get(TRADE_VIEW_KEY)) === "pro" ? "pro" : "lite";
  } catch {
    return "lite";
  }
}

export async function saveTradeView(kv: KV, v: TradeView): Promise<void> {
  try {
    await kv.set(TRADE_VIEW_KEY, v);
  } catch {
    // the choice still applies this session
  }
}

/** [view, set]: Lite until the stored choice loads; set() persists. */
export function useTradeView(kv: KV): [TradeView, (v: TradeView) => void] {
  const [view, setView] = useState<TradeView>("lite");
  useEffect(() => {
    let live = true;
    void loadTradeView(kv).then((v) => live && setView(v));
    return () => {
      live = false;
    };
  }, [kv]);
  return [
    view,
    (v) => {
      setView(v);
      void saveTradeView(kv, v);
    },
  ];
}

// ── other remembered Pro choices (same rules: non-secret, unreadable ⇒ the default) ──

export const CHART_MODE_KEY = "meridian.pref.chartMode";
export const PRO_TAB_KEY = "meridian.pref.proTab";
export type ChartMode = "line" | "candles";
export type ProTab = "books" | "trades";

export async function loadPref<T extends string>(kv: KV, key: string, allowed: readonly T[], fallback: T): Promise<T> {
  try {
    const v = await kv.get(key);
    return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

/** [value, set] for a remembered choice among `allowed`; `fallback` until it loads; set() persists. */
export function usePref<T extends string>(kv: KV, key: string, allowed: readonly T[], fallback: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(fallback);
  useEffect(() => {
    let live = true;
    void loadPref(kv, key, allowed, fallback).then((x) => live && setV(x));
    return () => {
      live = false;
    };
  }, [kv, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return [
    v,
    (x) => {
      setV(x);
      void kv.set(key, x).catch(() => undefined);
    },
  ];
}
