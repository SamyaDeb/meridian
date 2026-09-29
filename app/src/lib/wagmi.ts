import { createConfig, http } from "wagmi";
import { injected, mock } from "wagmi/connectors";
import { defineChain } from "viem";
import { foundry, monad, monadTestnet } from "viem/chains";

/** Local anvil (31337) whose DEFAULT rpc is NEXT_PUBLIC_LOCAL_RPC_URL: some connectors (wagmi `mock`) send through
 *  the chain's default rpc rather than the config transports, so both must point at the same node. */
export const LOCAL_RPC_URL = process.env.NEXT_PUBLIC_LOCAL_RPC_URL ?? "http://127.0.0.1:8545";
export const localChain = defineChain({ ...foundry, rpcUrls: { default: { http: [LOCAL_RPC_URL] } } });

// RPC URLs come from env (never hard-coded). Monad bills the gas *limit*: every tx sets estimateGas × 1.2 (see lib/gas.ts).
// Login (Privy vs Mera) is PENDING (BOUNTY_MAP; not yet recorded in docs/standup/C.md): injected wallet for now.
// Local dev only: NEXT_PUBLIC_DEV_ACCOUNT adds a connector for an unlocked anvil account (anvil signs
// eth_sendTransaction itself), so the app can trade on 31337 without a browser wallet.
const DEV_ACCOUNT = process.env.NEXT_PUBLIC_DEV_ACCOUNT as `0x${string}` | undefined;
export const wagmiConfig = createConfig({
  chains: [localChain, monadTestnet, monad],
  connectors: DEV_ACCOUNT ? [injected(), mock({ accounts: [DEV_ACCOUNT], features: { reconnect: true } })] : [injected()],
  transports: {
    [monadTestnet.id]: http(process.env.NEXT_PUBLIC_MONAD_TESTNET_RPC_URL),
    [monad.id]: http(process.env.NEXT_PUBLIC_MONAD_RPC_URL),
    [localChain.id]: http(LOCAL_RPC_URL),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
