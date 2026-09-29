"use client";
import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "@/lib/wagmi";
import { DataSourceProvider } from "@/data/context";
import { createMockSource } from "@/data/mock/source";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 250 } } }));
  const [source] = useState(() => createMockSource());
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <DataSourceProvider value={source}>{children}</DataSourceProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
