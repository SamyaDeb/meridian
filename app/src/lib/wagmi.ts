import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { foundry, monad, monadTestnet } from "viem/chains";

// RPC URLs come from env (never hard-coded). Monad bills the gas *limit*: every tx sets estimateGas × 1.2 (see lib/gas.ts).
// Login (Privy vs Mera) is decided Day 2 (BOUNTY_MAP); until then only an injected wallet connector.
export const wagmiConfig = createConfig({
  chains: [monadTestnet, monad, foundry],
  connectors: [injected()],
  transports: {
    [monadTestnet.id]: http(process.env.NEXT_PUBLIC_MONAD_TESTNET_RPC_URL),
    [monad.id]: http(process.env.NEXT_PUBLIC_MONAD_RPC_URL),
    [foundry.id]: http(process.env.NEXT_PUBLIC_LOCAL_RPC_URL ?? "http://127.0.0.1:8545"),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
