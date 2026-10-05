import type { PrivyClientConfig } from "@privy-io/react-auth";
import { monad, monadTestnet } from "viem/chains";

/** Privy app ID comes from env; absent ⇒ the app runs with the injected-wallet path only (cut order #4). */
export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID || undefined;
export const privyEnabled = Boolean(PRIVY_APP_ID);

/** Email login → embedded wallet created for every new user; external wallets stay available as the fallback. */
export function buildPrivyConfig(defaultChainId: number): PrivyClientConfig {
  const defaultChain = defaultChainId === monad.id ? monad : monadTestnet;
  return {
    loginMethods: ["email"],
    embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
    supportedChains: [monadTestnet, monad],
    defaultChain,
    appearance: { theme: "dark" },
  };
}
