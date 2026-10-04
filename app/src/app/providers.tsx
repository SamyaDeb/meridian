"use client";
import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "@/lib/wagmi";
import { DataSourceProvider } from "@/data/context";
import { createMockSource } from "@/data/mock/source";
import { createChainSource } from "@/data/chain/source";
import { type PublicClient, createPublicClient, http } from "viem";
import { READ_CHAIN_ID, readChain } from "@/lib/wagmi";
import { contractAddress } from "@/config/deployments";
import { WriteGateProvider } from "@/components/WriteGate";

/** NEXT_PUBLIC_DATA_SOURCE=chain reads the perp from deployments/<NEXT_PUBLIC_CHAIN_ID>.json (default 31337 = anvil);
 *  default = mock layer. NEXT_PUBLIC_LOG_SPAN / NEXT_PUBLIC_LOG_LOOKBACK fit the RPC's eth_getLogs cap on testnet. */
function makeSource() {
  const mockSource = createMockSource();
  if (process.env.NEXT_PUBLIC_DATA_SOURCE !== "chain") return mockSource;
  const ch = contractAddress(READ_CHAIN_ID, "ClearingHouse");
  const ob = contractAddress(READ_CHAIN_ID, "OrderBook");
  if (!ch || !ob) return mockSource;
  const { chain, rpcUrl } = readChain();
  const client = createPublicClient({ chain, transport: http(rpcUrl) });
  const oracle = contractAddress(READ_CHAIN_ID, "OracleAdapter");
  const vault = contractAddress(READ_CHAIN_ID, "PulseVault");
  const swapMarket = contractAddress(READ_CHAIN_ID, "FundingSwapMarket");
  const swapOrderBook = contractAddress(READ_CHAIN_ID, "SwapOrderBook");
  const span = process.env.NEXT_PUBLIC_LOG_SPAN;
  const lookback = process.env.NEXT_PUBLIC_LOG_LOOKBACK;
  return createChainSource(
    client as PublicClient,
    {
      chainId: READ_CHAIN_ID,
      clearingHouse: ch,
      orderBook: ob,
      ...(oracle ? { oracle } : {}),
      ...(vault ? { vault } : {}),
      ...(swapMarket ? { swapMarket } : {}),
      ...(swapOrderBook ? { swapOrderBook } : {}),
      ...(span ? { logSpan: BigInt(span) } : {}),
      ...(lookback ? { logLookback: BigInt(lookback) } : {}),
    },
    mockSource,
  );
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 250 } } }));
  const [source] = useState(makeSource);
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <DataSourceProvider value={source}>
          <WriteGateProvider>{children}</WriteGateProvider>
        </DataSourceProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
