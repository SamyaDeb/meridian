import { createConfig, http } from "wagmi";
import { injected, mock } from "wagmi/connectors";
import { defineChain } from "viem";
import { foundry, monad, monadTestnet } from "viem/chains";

/** Local anvil (31337) whose DEFAULT rpc is NEXT_PUBLIC_LOCAL_RPC_URL: some connectors (wagmi `mock`) send through
 *  the chain's default rpc rather than the config transports, so both must point at the same node. */
export const LOCAL_RPC_URL = process.env.NEXT_PUBLIC_LOCAL_RPC_URL ?? "http://127.0.0.1:8545";
/** NEXT_PUBLIC_LOCAL_CHAIN_ID=10143 = a LOCAL anvil started with --chain-id 10143 (the Phase 4 full-stack rehearsal).
 *  It then replaces monadTestnet in the config, so no connector can ever route a dev tx to the public testnet RPC. */
export const LOCAL_CHAIN_ID = Number(process.env.NEXT_PUBLIC_LOCAL_CHAIN_ID ?? String(foundry.id));
export const localChain = defineChain({
  ...foundry,
  id: LOCAL_CHAIN_ID,
  name: LOCAL_CHAIN_ID === foundry.id ? foundry.name : `Local rehearsal (chain id ${LOCAL_CHAIN_ID})`,
  rpcUrls: { default: { http: [LOCAL_RPC_URL] } },
});
const LOCAL_SHADOWS_TESTNET = LOCAL_CHAIN_ID === monadTestnet.id;

// RPC URLs come from env (never hard-coded). Monad bills the gas *limit*: every tx sets estimateGas × 1.2 (see lib/gas.ts).
// Login: Privy (email → embedded wallet) when NEXT_PUBLIC_PRIVY_APP_ID is set, else the injected wallet (decision D6).
// Privy's createConfig (src/app/PrivyProviders.tsx, loaded only with an app ID) builds its config from the same
// wagmiParameters, so the Privy SDK never ships in a build without NEXT_PUBLIC_PRIVY_APP_ID.
// Local dev only: NEXT_PUBLIC_DEV_ACCOUNT adds a connector for an unlocked anvil account (anvil signs
// eth_sendTransaction itself), so the app can trade on 31337 without a browser wallet.
const DEV_ACCOUNT = process.env.NEXT_PUBLIC_DEV_ACCOUNT as `0x${string}` | undefined;

/** With Privy (K1.1) external wallets connect through Privy's modal, which supplies its own connectors: the bare
 *  injected() is dropped. The anvil dev connector stays in both cases. Pure on its inputs. */
export function connectorsFor(privy: boolean, devAccount: `0x${string}` | undefined = DEV_ACCOUNT) {
  const dev = devAccount ? [mock({ accounts: [devAccount], features: { reconnect: true } })] : [];
  return privy ? dev : [injected(), ...dev];
}

export const wagmiParameters = {
  chains: LOCAL_SHADOWS_TESTNET ? [localChain, monad] : [localChain, monadTestnet, monad],
  connectors: connectorsFor(false),
  // With LOCAL_SHADOWS_TESTNET the local entry (same id 10143) is written last, so it wins.
  transports: {
    [monadTestnet.id]: http(process.env.NEXT_PUBLIC_MONAD_TESTNET_RPC_URL),
    [monad.id]: http(process.env.NEXT_PUBLIC_MONAD_RPC_URL),
    [localChain.id]: http(LOCAL_RPC_URL),
  },
  ssr: true,
} satisfies Parameters<typeof createConfig>[0];
export const wagmiConfig = createConfig(wagmiParameters);

/** Chain the read path (data source) follows: NEXT_PUBLIC_CHAIN_ID = 31337 (default, anvil) | 10143 | 143. */
export const READ_CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? String(localChain.id));
export function readChain(): { chain: typeof localChain | typeof monadTestnet | typeof monad; rpcUrl: string | undefined } {
  if (READ_CHAIN_ID === localChain.id) return { chain: localChain, rpcUrl: LOCAL_RPC_URL };
  if (READ_CHAIN_ID === monadTestnet.id) return { chain: monadTestnet, rpcUrl: process.env.NEXT_PUBLIC_MONAD_TESTNET_RPC_URL };
  if (READ_CHAIN_ID === monad.id) return { chain: monad, rpcUrl: process.env.NEXT_PUBLIC_MONAD_RPC_URL };
  return { chain: localChain, rpcUrl: LOCAL_RPC_URL };
}

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
