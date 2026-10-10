// Mounts Perpl for the app: one PerplVenue per unlocked wallet (created on unlock, disposed on lock / sign-out), fed
// with AppState. Screens subscribe to single fields through the hooks (leaf subscriptions, no screen-wide re-render).
import { perplExchangeAbi } from "@meridian/core/perpl";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { erc20Abi, type Abi } from "viem";
import { useAccountAddress, useAuthController, useAuthStatus } from "../../auth/AuthProvider";
import { secureKv } from "../../auth/secureKv";
import { useLive } from "../../live/LiveProvider";
import { Store, useStore } from "../../live/store";
import { walletClientFor } from "../../wallet/client";
import { sendTx } from "../../wallet/sendTx";
import type { OnboardingState } from "./onboarding";
import { rnFetch, rnRandom, rnWs } from "./runtime";
import { PerplTokenStore } from "./tokenStore";
import type { TradingSocketState } from "./tradingSocket";
import { PerplVenue } from "./venue";

const PerplContext = createContext<PerplVenue | undefined>(undefined);

/** Perpl's exchange + ERC-20 errors, for plain-English reverts in sendTx */
export const PERPL_TX_ABI = [...perplExchangeAbi, ...erc20Abi] as unknown as Abi;

export const perplTokenStore = new PerplTokenStore(secureKv);

export function PerplProvider({ children, venue: injected }: { children: ReactNode; venue?: PerplVenue }) {
  const auth = useAuthController();
  const live = useLive();
  const status = useAuthStatus();
  const { address } = useAccountAddress();
  const [venue, setVenue] = useState<PerplVenue | undefined>(injected);

  useEffect(() => {
    if (injected) return;
    const cfg = live.config;
    if (status !== "unlocked" || !address || cfg.perpl.status !== "deployed" || !cfg.perplWsUrl || !live.client) {
      setVenue(undefined);
      return;
    }
    const pub = live.client;
    const v = new PerplVenue({
      deployment: cfg.perpl.deployment,
      chainId: cfg.chainId,
      address,
      wsUrl: cfg.perplWsUrl,
      auth,
      tokens: perplTokenStore,
      chain: pub as never,
      sendWith: (account, req) => sendTx(pub, walletClientFor(account, cfg), req, { abi: PERPL_TX_ABI }),
      fetchFn: rnFetch,
      wsFactory: rnWs,
      random: rnRandom,
      now: () => Date.now(),
    });
    setVenue(v);
    void v.refresh().catch(() => undefined);
    const sub = AppState.addEventListener("change", (s) => v.onAppState(s));
    return () => {
      sub.remove();
      v.dispose();
    };
  }, [auth, live, status, address, injected]);

  return <PerplContext.Provider value={venue}>{children}</PerplContext.Provider>;
}

/** The unlocked wallet's Perpl venue; undefined while locked or when Perpl isn't configured on this chain. */
export const usePerpl = (): PerplVenue | undefined => useContext(PerplContext);

const NO_ONB = new Store<OnboardingState | undefined>(undefined);
const NO_SOCK = new Store<TradingSocketState | undefined>(undefined);

/** One onboarding field (pass a stable selector). */
export function usePerplOnboarding<S>(select: (s: OnboardingState | undefined) => S): S {
  const v = usePerpl();
  return useStore((v?.onboarding.store as Store<OnboardingState | undefined> | undefined) ?? NO_ONB, select);
}

/** One trading-socket field (pass a stable selector). */
export function usePerplSocket<S>(select: (s: TradingSocketState | undefined) => S): S {
  const v = usePerpl();
  return useStore((v?.socket.store as Store<TradingSocketState | undefined> | undefined) ?? NO_SOCK, select);
}
