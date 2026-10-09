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
