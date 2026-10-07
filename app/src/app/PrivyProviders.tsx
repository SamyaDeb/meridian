"use client";
import type { ReactNode } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import { PrivyProvider } from "@privy-io/react-auth";
import { WagmiProvider, createConfig } from "@privy-io/wagmi";
import { PRIVY_APP_ID, buildPrivyConfig } from "@/lib/privy";
import { READ_CHAIN_ID, connectorsFor, type wagmiConfig, wagmiParameters } from "@/lib/wagmi";
import { PrivySponsorBridge } from "@/components/PrivyControls";

// Loaded with next/dynamic only when NEXT_PUBLIC_PRIVY_APP_ID is set (decision D6), so a build without it ships none of
// the Privy SDK. Privy's createConfig adds its own connectors to the same chains / transports; the bare injected()
// is dropped (external wallets connect through Privy's modal, K1.1), the anvil dev connector is kept.
// Same runtime shape as wagmiConfig (the app's registered wagmi type); only the connector generics differ.
const privyWagmiConfig = createConfig({ ...wagmiParameters, connectors: connectorsFor(true) }) as unknown as typeof wagmiConfig;

/** Order mandated by @privy-io/wagmi: PrivyProvider > QueryClientProvider > WagmiProvider (Privy's). */
export default function PrivyProviders({ queryClient, children }: { queryClient: QueryClient; children: ReactNode }) {
  return (
    <PrivyProvider appId={PRIVY_APP_ID!} config={buildPrivyConfig(READ_CHAIN_ID)}>
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={privyWagmiConfig}>
          <PrivySponsorBridge>{children}</PrivySponsorBridge>
        </WagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  );
}
