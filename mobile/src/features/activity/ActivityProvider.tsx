// Activity for the unlocked wallet: the receipts log (written by the Trade executor) and the merged feed. Mounted above
// TradeProvider so the executor can log, and above the sheet portal like the other app-wide stores.
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useAccountAddress, useAuthStatus } from "../../auth/AuthProvider";
import { secureKv } from "../../auth/secureKv";
import { useLive } from "../../live/LiveProvider";
import { usePerpl } from "../../venues/perpl/PerplProvider";
import { rnFetch } from "../../venues/perpl/runtime";
import { dpOfTick } from "../../ui/format";
import { ActivityFeed } from "./feed";
import { ActivityLog, activityLogKey } from "./log";

export type ActivityKit = { log: ActivityLog | undefined; feed: ActivityFeed | undefined };

const Ctx = createContext<ActivityKit>({ log: undefined, feed: undefined });

export function ActivityProvider({ children, kit: injected }: { children: ReactNode; kit?: ActivityKit }) {
  const live = useLive();
  const status = useAuthStatus();
  const { address } = useAccountAddress();
  const venue = usePerpl();
  // the feed reads the venue at refresh time: it stays one object (and keeps its rows) while the venue re-renders
  const venueRef = useRef(venue);
  venueRef.current = venue;
  const cfg = live.config;

  const kit = useMemo<ActivityKit>(() => {
    if (injected) return injected;
    if (status !== "unlocked" || !address) return { log: undefined, feed: undefined };
    const log = new ActivityLog(secureKv, activityLogKey(cfg.chainId, address));
    const p = cfg.perpl.status === "deployed" ? cfg.perpl.deployment : undefined;
    const meta = p ? p.markets[p.monMarketId] : undefined;
    const feed = new ActivityFeed({
      log,
      perpl: () => {
        const rest = venueRef.current?.onboarding.signedRest();
        return rest && p && meta ? { rest, market: { id: meta.id, priceDecimals: meta.priceDecimals, sizeDecimals: meta.sizeDecimals, collateralDecimals: p.collateralDecimals } } : undefined;
      },
      perplOff: () => (!p ? "Perpl isn't on this network." : "Turn on Perpl trading (Settings) to see its history here."),
      meridian:
        cfg.indexerUrl && cfg.meridian.status === "deployed"
          ? {
              url: cfg.indexerUrl,
              account: address,
              fetchFn: rnFetch,
              meta: () => {
                const m = live.meridian?.store.get();
                return { priceDp: dpOfTick(m?.tickSizeWad), lotSizeWad: m?.lotSizeWad };
              },
            }
          : undefined,
      explorerBase: cfg.chain.blockExplorers?.default.url,
    });
    return { log, feed };
  }, [injected, status, address, cfg, live]);

  useEffect(() => {
    void kit.log?.load();
  }, [kit]);

  return <Ctx.Provider value={kit}>{children}</Ctx.Provider>;
}

export const useActivity = (): ActivityKit => useContext(Ctx);
