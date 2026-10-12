"use client";
import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { WagmiProvider } from "wagmi";
import { privyEnabled } from "@/lib/privy";
import { wagmiConfig } from "@/lib/wagmi";
import { DataSourceProvider } from "@/data/context";
import { createMockSource } from "@/data/mock/source";
import { createChainSource } from "@/data/chain/source";
import { type PublicClient, createPublicClient, http } from "viem";
import { READ_CHAIN_ID, readChain } from "@/lib/wagmi";
import { contractAddress, deploymentFor } from "@/config/deployments";
import { type PerpMarket, mockMarkets, perpMarkets, visibleMarkets } from "@/config/markets";
import { MarketProvider, MarketSourcesProvider, usePerpMarket } from "@/data/market";
import { withPerpMarket } from "@/data/composite";
import { ETH_MOCK_K, createScaledMockSource } from "@/data/mock/scaled";
import { MOCK } from "@/data/mock/fixtures";
import type { MeridianDataSource } from "@/data/source";
import { WriteGateProvider } from "@/components/WriteGate";

// Privy SDK only in builds with NEXT_PUBLIC_PRIVY_APP_ID (decision D6): its own chunk, never fetched otherwise.
const PrivyProviders = privyEnabled ? dynamic(() => import("./PrivyProviders")) : null;

/** NEXT_PUBLIC_DATA_SOURCE=chain reads the perp markets from deployments/<NEXT_PUBLIC_CHAIN_ID>.json (default 31337 =
 *  anvil); default = mock layer. NEXT_PUBLIC_LOG_SPAN / NEXT_PUBLIC_LOG_LOOKBACK fit the RPC's eth_getLogs cap on testnet.
 *  K7: one source per switchable market (config/markets.ts); vault / swaps / stats always from the primary one. */
function makeSources(): { markets: PerpMarket[]; sources: Map<string, MeridianDataSource> } {
  const mockSource = createMockSource();
  const chainMode = process.env.NEXT_PUBLIC_DATA_SOURCE === "chain";
  const live = chainMode ? visibleMarkets(perpMarkets(deploymentFor(READ_CHAIN_ID)), process.env.NEXT_PUBLIC_HIDE_MARKETS) : [];
  if (live.length === 0) {
    const markets = mockMarkets(MOCK);
    const eth = markets[1]!;
    const ethMock = createScaledMockSource(mockSource, {
      symbol: eth.symbol,
      clearingHouse: eth.clearingHouse,
      orderBook: eth.orderBook,
      k: ETH_MOCK_K,
      tickSizeWad: eth.tickSizeWad,
      lotSizeWad: eth.lotSizeWad,
      maxOpenInterest: 25n * 10n ** 17n,
      maxPositionSize: 25n * 10n ** 16n,
    });
    return {
      markets,
      sources: new Map([
        ["main", withPerpMarket(mockSource, mockSource, "main")],
        [eth.key, withPerpMarket(mockSource, ethMock, eth.key)],
      ]),
    };
  }
  const { chain, rpcUrl } = readChain();
  // Reads issued in the same tick go out as one Multicall3 eth_call (the chain defs carry its address; on 10143 it has
  // code), and what can't be multicalled (block number, logs) shares one JSON-RPC batch. The page polls every block,
  // so one call per read put a single tab near the public testnet RPC's per-IP eth_call limit (429s: market strip,
  // RPC chip and block stayed "—").
  const client = createPublicClient({ chain, transport: http(rpcUrl, { batch: { wait: 16 } }), batch: { multicall: { wait: 16 } } });
  const vault = contractAddress(READ_CHAIN_ID, "MeridianVault");
  const swapMarket = contractAddress(READ_CHAIN_ID, "FundingSwapMarket");
  const swapOrderBook = contractAddress(READ_CHAIN_ID, "SwapOrderBook");
  const span = process.env.NEXT_PUBLIC_LOG_SPAN;
  const lookback = process.env.NEXT_PUBLIC_LOG_LOOKBACK;
  const build = (m: PerpMarket) =>
    createChainSource(
      client as PublicClient,
      {
        chainId: READ_CHAIN_ID,
        symbol: m.symbol,
        clearingHouse: m.clearingHouse,
        orderBook: m.orderBook,
        ...(m.oracle ? { oracle: m.oracle } : {}),
        ...(m.primary && vault ? { vault } : {}),
        ...(m.primary && swapMarket ? { swapMarket } : {}),
        ...(m.primary && swapOrderBook ? { swapOrderBook } : {}),
        ...(span ? { logSpan: BigInt(span) } : {}),
        ...(lookback ? { logLookback: BigInt(lookback) } : {}),
      },
      mockSource,
    );
  const primary = build(live[0]!);
  const sources = new Map<string, MeridianDataSource>();
  for (const m of live) sources.set(m.key, withPerpMarket(primary, m.primary ? primary : build(m), m.key));
  return { markets: live, sources };
}

/** Hands the selected market's source to the data hooks. */
function SelectedSource({ sources, children }: { sources: Map<string, MeridianDataSource>; children: ReactNode }) {
  const market = usePerpMarket();
  const source = sources.get(market.key) ?? sources.values().next().value!;
  return <DataSourceProvider value={source}>{children}</DataSourceProvider>;
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 250 } } }));
  const [{ markets, sources }] = useState(makeSources);
  const tree = (
    <MarketProvider markets={markets}>
      <MarketSourcesProvider value={sources}>
        <SelectedSource sources={sources}>
          <WriteGateProvider>{children}</WriteGateProvider>
        </SelectedSource>
      </MarketSourcesProvider>
    </MarketProvider>
  );
  if (PrivyProviders) return <PrivyProviders queryClient={queryClient}>{tree}</PrivyProviders>;
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{tree}</QueryClientProvider>
    </WagmiProvider>
  );
}
