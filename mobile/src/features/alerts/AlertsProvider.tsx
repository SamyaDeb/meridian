// In-app alerts for the unlocked wallet (rules.ts): off until the user turns one on in Settings (progressive; no OS
// permission prompt: there are no phone notifications in this build). While the liquidation alert is on and the app is
// in the foreground, the account reader keeps reading per block even off Home / Trade, so the alert can fire anywhere.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { useAuthStatus } from "../../auth/AuthProvider";
import type { KV } from "../../auth/credentialStore";
import { secureKv } from "../../auth/secureKv";
import { useLive } from "../../live/LiveProvider";
import { Store } from "../../live/store";
import { haptic, useToast } from "../../ui";
import { positionViews } from "../trade/positions/views";
import { holdAccountReads, useTrade } from "../trade/TradeProvider";
import { ALERTS_KEY, decodePrefs, freshMemory, fundingAlerts, liqAlerts, NO_ALERTS, type AlertPrefs } from "./rules";

export class AlertSettings {
  readonly store = new Store<AlertPrefs>(NO_ALERTS);
  constructor(private readonly kv: KV) {}
  async load(): Promise<void> {
    try {
      this.store.set(decodePrefs(await this.kv.get(ALERTS_KEY)));
    } catch {
      // defaults: everything off
    }
  }
  async set(patch: Partial<AlertPrefs>): Promise<void> {
    const next = { ...this.store.get(), ...patch };
    this.store.set(next);
    try {
      await this.kv.set(ALERTS_KEY, JSON.stringify(next));
    } catch {
      // applies this session
    }
  }
}

const Ctx = createContext<AlertSettings | undefined>(undefined);

export function AlertsProvider({ children, settings: injected }: { children: ReactNode; settings?: AlertSettings }) {
  const [settings] = useState(() => injected ?? new AlertSettings(secureKv));
  const status = useAuthStatus();
  const live = useLive();
  const { accounts, focus } = useTrade();
  const toast = useToast();
  const [prefs, setPrefs] = useState(settings.store.get());

  useEffect(() => {
    void settings.load();
    return settings.store.subscribe(() => setPrefs(settings.store.get()));
  }, [settings]);

  const unlocked = status === "unlocked";
  const mem = useMemo(() => freshMemory(), []);

  // liquidation distance, per account read
  useEffect(() => {
    if (!unlocked || !prefs.liq || !accounts) return;
    let release = AppState.currentState === "active" ? holdAccountReads(focus) : undefined;
    const app = AppState.addEventListener("change", (st) => {
      if (st === "active") release ??= holdAccountReads(focus);
      else {
        release?.();
        release = undefined;
      }
    });
    const unsub = accounts.store.subscribe(() => {
      const views = positionViews(accounts.store.get(), live.meridian?.store.get(), live.perpl?.store.get());
      const d = { meridian: views.find((v) => v.venue === "meridian")?.distanceBps, perpl: views.find((v) => v.venue === "perpl")?.distanceBps };
      for (const a of liqAlerts(mem, d)) toast(a.text, "error"); // the error toast buzzes (ui/Toast)
    });
    return () => {
      unsub();
      app.remove();
      release?.();
    };
  }, [unlocked, prefs.liq, accounts, focus, live, mem, toast]);

  // funding flips, on each venue's own update
  useEffect(() => {
    if (!unlocked || !prefs.funding) return;
    const check = () => {
      for (const a of fundingAlerts(mem, { meridian: live.meridian?.store.get().rateWad, perpl: live.perpl?.store.get().aprNowWad })) {
        haptic.selection();
        toast(a.text, "info");
      }
    };
    check(); // remembers the current sides; only a later change alerts
    const subs = [live.meridian?.store.subscribe(check), live.perpl?.store.subscribe(check)];
    return () => subs.forEach((u) => u?.());
  }, [unlocked, prefs.funding, live, mem, toast]);

  return <Ctx.Provider value={settings}>{children}</Ctx.Provider>;
}

export const useAlertSettings = (): AlertSettings | undefined => useContext(Ctx);
