// wagmi connector for the passkey wallet (mera-passkeys §3). Signs locally with the Mera session (viem LocalAccount)
// and sends raw transactions through the config's transport for the chain, so every write in lib/tx.ts works
// unchanged (estimate × 1.2 gas limit included). Never Privy-sponsored: sponsorship is for Privy embedded wallets only.
//
// Not listed in the config's connectors on purpose: @privy-io/wagmi 4.0.18 replaces that list with Privy's wallets
// whenever they change (useSyncPrivyWallets), so the connector is handed to wagmi's connect action directly and lives
// only in the connection it makes. A locked wallet (idle, hidden tab, manual) disconnects it.
import { connect } from "wagmi/actions";
import { ChainNotConfiguredError, createConnector, type Config } from "wagmi";
import { createPublicClient, createWalletClient, getAddress, http, numberToHex, type Address, type Chain } from "viem";
import type { PasskeyWallet } from "./wallet";

export const PASSKEY_CONNECTOR_TYPE = "mera";
export const PASSKEY_CONNECTOR_ID = "meridian-passkey";

type Provider = { request(args: { method: string; params?: unknown }): Promise<unknown> };

export function passkeyConnector(wallet: PasskeyWallet, initialChainId?: number) {
  return createConnector<Provider>((config) => {
    let chainId = config.chains.find((c) => c.id === initialChainId)?.id ?? config.chains[0].id;
    let unsubscribe: (() => void) | undefined;
    const chainOf = (id: number): Chain => {
      const c = config.chains.find((x) => x.id === id);
      if (!c) throw new ChainNotConfiguredError();
      return c;
    };
    const transportOf = (id: number) => config.transports?.[id] ?? http();
    const accounts = (): Address[] => {
      const a = wallet.account();
      return a ? [a.address] : [];
    };
    const stopWatching = () => {
      unsubscribe?.();
      unsubscribe = undefined;
    };
    return {
      id: PASSKEY_CONNECTOR_ID,
      name: "Passkey",
      type: PASSKEY_CONNECTOR_TYPE,
      async connect(params) {
        const a = wallet.account();
        if (!a) throw new Error("Passkey wallet is locked");
        if (params?.chainId !== undefined) chainId = chainOf(params.chainId).id;
        stopWatching();
        unsubscribe = wallet.subscribe(() => {
          if (wallet.getState().status === "unlocked") return;
          stopWatching();
          config.emitter.emit("disconnect");
        });
        const out = params?.withCapabilities ? { accounts: [{ address: a.address, capabilities: {} }], chainId } : { accounts: [a.address], chainId };
        return out as never;
      },
      async disconnect() {
        stopWatching();
        wallet.lock("manual");
      },
      async getAccounts() {
        return accounts();
      },
      async getChainId() {
        return chainId;
      },
      /** Minimal EIP-1193: account + chain from the session, everything else read through the chain's transport. */
      async getProvider(p) {
        const chain = chainOf(p?.chainId ?? chainId);
        const pub = createPublicClient({ chain, transport: transportOf(chain.id) });
        return {
          async request({ method, params }) {
            if (method === "eth_accounts" || method === "eth_requestAccounts") return accounts();
            if (method === "eth_chainId") return numberToHex(chainId);
            return pub.request({ method, params } as never);
          },
        };
      },
      async getClient(p) {
        const account = wallet.account();
        if (!account) throw new Error("Passkey wallet is locked");
        const chain = chainOf(p?.chainId ?? chainId);
        return createWalletClient({ account, chain, transport: transportOf(chain.id) });
      },
      async isAuthorized() {
        return wallet.getState().status === "unlocked";
      },
      async switchChain({ chainId: id }) {
        const chain = chainOf(id);
        chainId = id;
        config.emitter.emit("change", { chainId: id });
        return chain;
      },
      onAccountsChanged(a) {
        if (a.length === 0) config.emitter.emit("disconnect");
        else config.emitter.emit("change", { accounts: a.map((x) => getAddress(x)) });
      },
      onChainChanged(c) {
        config.emitter.emit("change", { chainId: Number(c) });
      },
      onDisconnect() {
        stopWatching();
        config.emitter.emit("disconnect");
      },
    };
  });
}

/** wagmi may still be finishing a (re)connect started by Privy's sync after a logout; connecting during it races. */
async function settled(config: Config, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now();
  while ((config.state.status === "connecting" || config.state.status === "reconnecting") && Date.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 50));
}

/** Makes the unlocked passkey wallet wagmi's active connection on `chainId`. */
export async function connectPasskey(config: Config, wallet: PasskeyWallet, chainId: number) {
  await settled(config);
  return connect(config, { connector: passkeyConnector(wallet, chainId), chainId });
}
