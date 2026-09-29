"use client";
import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "@/lib/wagmi";
import { DataSourceProvider } from "@/data/context";
import { createMockSource } from "@/data/mock/source";
import { createChainSource } from "@/data/chain/source";
import { createPublicClient, http } from "viem";
import { LOCAL_RPC_URL, localChain } from "@/lib/wagmi";
import { contractAddress } from "@/config/deployments";

/** NEXT_PUBLIC_DATA_SOURCE=chain reads the perp from anvil (deployments/31337.json); default = mock layer. */
function makeSource() {
  const mockSource = createMockSource();
  if (process.env.NEXT_PUBLIC_DATA_SOURCE !== "chain") return mockSource;
  const ch = contractAddress(localChain.id, "ClearingHouse");
  const ob = contractAddress(localChain.id, "OrderBook");
  if (!ch || !ob) return mockSource;
  const client = createPublicClient({ chain: localChain, transport: http(LOCAL_RPC_URL) });
  const oracle = contractAddress(localChain.id, "OracleAdapter");
  return createChainSource(client, { chainId: localChain.id, clearingHouse: ch, orderBook: ob, ...(oracle ? { oracle } : {}) }, mockSource);
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 250 } } }));
  const [source] = useState(makeSource);
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <DataSourceProvider value={source}>{children}</DataSourceProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
