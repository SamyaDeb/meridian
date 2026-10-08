"use client";
// Selected perp market (K7). The terminal, ticket, book, positions and funding read it; Earn / Fix stay on the primary
// market. Selection: ?market=<key> first, then the last choice (localStorage, a per-viewer convenience), else primary.
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { type PerpMarket, mockMarkets, pickMarket } from "@/config/markets";
import type { MeridianDataSource } from "./source";

const STORAGE_KEY = "meridian.market";
const ZERO = "0x0000000000000000000000000000000000000000" as const;

interface MarketState {
  market: PerpMarket;
  markets: readonly PerpMarket[];
  setMarket: (key: string) => void;
}

const fallback = mockMarkets({ clearingHouse: ZERO, orderBook: ZERO });
const MarketContext = createContext<MarketState>({ market: fallback[0]!, markets: fallback.slice(0, 1), setMarket: () => {} });

/** Initial key: the URL's ?market= when it names a market, else the stored one. Pure. */
export function initialMarketKey(markets: readonly PerpMarket[], urlKey: string | null, storedKey: string | null): string {
  if (urlKey && markets.some((m) => m.key === urlKey)) return urlKey;
  if (storedKey && markets.some((m) => m.key === storedKey)) return storedKey;
  return markets[0]?.key ?? "main";
}

const CHANGE_EVENT = "meridian:market";

/** Reads ?market= and the stored choice (client only). */
function readKey(markets: readonly PerpMarket[]): string {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    /* storage blocked: the URL / primary market still work */
  }
  return initialMarketKey(markets, new URLSearchParams(window.location.search).get("market"), stored);
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("popstate", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("popstate", onChange);
  };
}

export function MarketProvider({ markets, children }: { markets: readonly PerpMarket[]; children: ReactNode }) {
  // server render + hydration use the primary market; the client then reads the URL / storage (no mismatch)
  const key = useSyncExternalStore(
    subscribe,
    () => readKey(markets),
    () => markets[0]?.key ?? "main",
  );
  const setMarket = useCallback(
    (k: string) => {
      if (!markets.some((m) => m.key === k)) return;
      try {
        window.localStorage.setItem(STORAGE_KEY, k);
      } catch {
        /* ignore */
      }
      const u = new URL(window.location.href);
      if (k === markets[0]?.key) u.searchParams.delete("market");
      else u.searchParams.set("market", k);
      window.history.replaceState(window.history.state, "", u);
      window.dispatchEvent(new Event(CHANGE_EVENT));
    },
    [markets],
  );
  const value = useMemo(() => ({ market: pickMarket(markets, key) ?? fallback[0]!, markets, setMarket }), [markets, key, setMarket]);
  return <MarketContext.Provider value={value}>{children}</MarketContext.Provider>;
}

/** The selected perp market. */
export const usePerpMarket = (): PerpMarket => useContext(MarketContext).market;
/** All switchable markets and the setter. */
export const usePerpMarkets = (): MarketState => useContext(MarketContext);

/** Every market's data source by key (providers.tsx), for per-market tables (/rates, /stats). */
const SourcesContext = createContext<ReadonlyMap<string, MeridianDataSource>>(new Map());
export const MarketSourcesProvider = SourcesContext.Provider;
export const useMarketSources = (): ReadonlyMap<string, MeridianDataSource> => useContext(SourcesContext);
