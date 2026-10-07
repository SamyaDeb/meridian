"use client";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount, useConnect, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import type { PublicClient, WalletClient } from "viem";
import { useWriteGate } from "./WriteGate";
import { pushNotification } from "@/lib/notify";
import dynamic from "next/dynamic";
import { describeSignError } from "@/lib/login";
import { privyEnabled } from "@/lib/privy";
import { isSponsored } from "@/lib/sponsor";
import { withSponsoredSend } from "@/lib/tx";
import { READ_CHAIN_ID } from "@/lib/wagmi";
import { useSession } from "./Session";

export const cta = "inline-flex h-9 items-center whitespace-nowrap rounded-full px-4 text-xs font-semibold pointer-coarse:h-11";

// Privy SDK only in builds with NEXT_PUBLIC_PRIVY_APP_ID (decision D6): a separate chunk, never fetched otherwise.
const PrivyConnect = privyEnabled ? dynamic(() => import("./PrivyControls").then((m) => m.PrivyConnect)) : null;

/** Connect: Privy's login modal (email, passkey, Google, external wallet) when NEXT_PUBLIC_PRIVY_APP_ID is set (K1.1),
 *  else the injected wallet or, on anvil, the dev account connector (decision D6). */
export function ConnectButton() {
  return PrivyConnect ? <PrivyConnect /> : <InjectedConnect />;
}

function InjectedConnect() {
  const { isConnected, address } = useAccount();
  const { connectors, connect } = useConnect();
  if (isConnected) return <span className="num text-[11px] text-muted">{`${address?.slice(0, 6)}…${address?.slice(-4)}`}</span>;
  return (
    <div className="flex gap-2">
      {connectors.map((c) => (
        <button key={c.uid} type="button" onClick={() => connect({ connector: c })} className={`${cta} bg-brand text-on-brand hover:bg-brand-hover`}>
          {c.type === "mock" ? "Dev account" : "Connect wallet"}
        </button>
      ))}
    </div>
  );
}

/** Is the next write gas-sponsored? Privy on, embedded wallet, testnet, kill switch not thrown (lib/sponsor.ts). */
export function useSponsored(): boolean {
  const { privy, walletKind, sponsoredSend } = useSession();
  return Boolean(sponsoredSend) && isSponsored({ privyEnabled: privy, walletKind, chainId: READ_CHAIN_ID, killSwitch: process.env.NEXT_PUBLIC_SPONSOR_GAS });
}

/** Runs one write at a time with a status line; refreshes every query after success. Every write passes the gate first
 *  (terms accepted for this version, viewer not geo-restricted: C3). Sponsored wallets send through Privy (K1.2). */
export function useTx() {
  const pub = usePublicClient();
  const { data: wallet } = useWalletClient();
  const qc = useQueryClient();
  const gate = useWriteGate();
  const { chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { sponsoredSend } = useSession();
  const sponsored = useSponsored();
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);
  async function run(label: string, fn: (p: PublicClient, w: WalletClient) => Promise<{ block: bigint; gasUsed: bigint; gasLimit: bigint }>) {
    if (!pub || !wallet) return setStatus("Connect first");
    if (!(await gate.ensure())) return setStatus(`${label} cancelled`);
    if (chainId !== undefined && chainId !== READ_CHAIN_ID) {
      try {
        await switchChainAsync({ chainId: READ_CHAIN_ID });
      } catch {
        return setStatus("Wrong network: switch to Monad and retry");
      }
    }
    setBusy(true);
    setStatus(`${label}…`);
    try {
      const w = sponsored && sponsoredSend ? withSponsoredSend(wallet as WalletClient, sponsoredSend) : (wallet as WalletClient);
      const r = await fn(pub as PublicClient, w);
      // block 0 = nothing was sent (a mocked client); never word it like an onchain confirmation
      if (r.block === 0n) {
        setStatus(`${label} ✓ (no transaction sent)`);
        pushNotification("info", `${label}: done locally, no transaction sent`);
      } else {
        setStatus(`${label} ✓ block ${r.block} · gas ${r.gasUsed}/${r.gasLimit}`);
        pushNotification("ok", `${label} confirmed in block ${r.block}`);
      }
      await qc.invalidateQueries();
    } catch (e) {
      const msg = `${label} failed: ${describeSignError(e)}`;
      setStatus(msg);
      pushNotification("error", msg);
    } finally {
      setBusy(false);
    }
  }
  return { run, status, busy, ready: Boolean(pub && wallet), sponsored };
}
