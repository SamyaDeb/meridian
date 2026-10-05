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
import { READ_CHAIN_ID } from "@/lib/wagmi";

export const cta = "inline-flex h-9 items-center whitespace-nowrap rounded-full px-4 text-xs font-semibold pointer-coarse:h-11";

// Privy SDK only in builds with NEXT_PUBLIC_PRIVY_APP_ID (decision D6): a separate chunk, never fetched otherwise.
const PrivyConnect = privyEnabled ? dynamic(() => import("./PrivyControls").then((m) => m.PrivyConnect)) : null;

/** Connect: Privy email login when NEXT_PUBLIC_PRIVY_APP_ID is set (injected wallet kept as a secondary option, decision
 *  D6), else the injected wallet or, on anvil, the dev account connector. */
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

/** Runs one write at a time with a status line; refreshes every query after success. Every write passes the gate first
 *  (terms accepted for this version, viewer not geo-restricted: C3). */
export function useTx() {
  const pub = usePublicClient();
  const { data: wallet } = useWalletClient();
  const qc = useQueryClient();
  const gate = useWriteGate();
  const { chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
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
      const r = await fn(pub as PublicClient, wallet as WalletClient);
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
  return { run, status, busy, ready: Boolean(pub && wallet) };
}
