import type { PrivyClientConfig } from "@privy-io/react-auth";
import { monad, monadTestnet } from "viem/chains";

/** Privy app ID comes from env; absent ⇒ the app runs with the injected-wallet path only (cut order #4). */
export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID || undefined;
export const privyEnabled = Boolean(PRIVY_APP_ID);

/** Privy is the single auth layer (K1.1): email, passkey, Google or an external wallet, all through Privy's modal. An
 *  embedded wallet is created for every user without one (only embedded wallets get sponsored gas, lib/sponsor.ts).
 *  Values checked against PrivyClientConfig['loginMethods'] in @privy-io/react-auth 3.47.0. */
export function buildPrivyConfig(defaultChainId: number): PrivyClientConfig {
  const defaultChain = defaultChainId === monad.id ? monad : monadTestnet;
  return {
    loginMethods: ["email", "passkey", "google", "wallet"],
    embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
    supportedChains: [monadTestnet, monad],
    defaultChain,
    appearance: { theme: "dark" },
  };
}
